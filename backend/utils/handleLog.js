require('dotenv').config()

const fs = require('fs')
const Web3 = require('web3')
const util = require('ethereumjs-util')

const Stripe = require('stripe')

const get = require('lodash/get')
const set = require('lodash/set')

const { getText, getIPFSGateway } = require('./_ipfs')
const abi = require('./_abi')
const sendNewOrderEmail = require('./emails/newOrder')
const { upsertEvent, getEventObj } = require('./events')
const { getConfig } = require('./encryptedConfig')
const discordWebhook = require('./discordWebhook')
const { Network, Order, Shop, ExternalPayment } = require('../models')
const { getLogger } = require('../utils/logger')
const { autoFulfillOrder } = require('../utils/printful')
const { decryptShopOfferData } = require('../utils/offer')
const { Sentry } = require('../sentry')
const { ListingID } = require('./id')

const log = getLogger('utils.handleLog')

const { validateDiscountOnOrder } = require('./discounts')

const { DSHOP_CACHE, IS_TEST } = require('../utils/const')

const IPFS_TIMEOUT = 60000 // 60sec in msec

const web3 = new Web3()
const Marketplace = new web3.eth.Contract(abi)
const MarketplaceABI = Marketplace._jsonInterface

/**
 * Handles processing events emitted by the marketplace contract.
 *
 * @param {Integer} networkId: Ethereum network id
 * @param {string} contractVersion: Version of the marketplace contract. Ex: '001'
 * @param {Object} data: blockchain event data
 * @param {Array<Object>} topics: event topics
 * @param {string} transactionHash: blockchain transaction hash
 * @param {Integer} blockNumber: block number
 * @param {Function} mockGetEventObj: for testing only. Mock function to call to parse the event.
 * @returns {Promise<void>}
 * @throws {Error}
 */
async function handleLog({
  networkId,
  contractVersion,
  address,
  data,
  topics,
  transactionHash,
  blockNumber,
  blockHash,
  mockGetEventObj,
  mockUpsert
}) {
  const isTest = process.env.NODE_ENV === 'test'

  const network = await Network.findOne({ where: { networkId } })
  web3.setProvider(network.provider)

  const eventAbi = MarketplaceABI.find((i) => i.signature === topics[0])
  if (!eventAbi) {
    log.warn('Unknown event')
    return
  }

  const rawEvent = {
    address,
    data,
    topics,
    transactionHash,
    blockNumber,
    blockHash
  }

  // Decorate the raw event with marketplace specific fields.
  const getEventObjFn =
    isTest && mockGetEventObj ? mockGetEventObj : getEventObj
  const eventObj = getEventObjFn(rawEvent)

  const listingId = `${networkId}-${contractVersion}-${eventObj.listingId}`
  log.info(`Received event ${eventObj.eventName} for listing ${listingId}`)

  // Lookup the Dshop associated with the event, if any.
  const shop = await Shop.findOne({ where: { listingId } })
  const shopId = shop ? shop.id : null

  // Note: we persist all marketplace events in the DB, not only dshop related ones.
  // This is to facilitate troubleshooting.
  const upsertEventFn = isTest && mockUpsert ? mockUpsert : upsertEvent
  const event = await upsertEventFn({
    web3,
    shopId,
    networkId,
    event: rawEvent
  })

  log.info(
    `Processing event ${eventObj.eventName} on listing ${listingId} for shop ${shopId}`
  )
  await processDShopEvent({ event, shop })
}

/**
 * Refunds a Stripe payment.
 *
 * @param {models.Event} event: Event DB object.
 * @param {models.Shop} shop: Shop DB object.
 * @param {models.Order} order: Order DB object.
 * @returns {Promise<null|string>} Returns null or the reason for the Stripe failure.
 * @throws {Error}
 * @private
 */
async function _processStripeRefund({ event, shop, order }) {
  if (IS_TEST) {
    log.info('Test environment. Skipping Stripe refund logic.')
    return null
  }
  log.info('Trying to refund Stripe payment')
  // Load the shop configuration.
  const shopConfig = getConfig(shop.config)
  const { dataUrl } = shopConfig
  const ipfsGateway = await getIPFSGateway(dataUrl, event.networkId)
  log.info('IPFS Gateway', ipfsGateway)

  // Load the offer data to get the paymentCode
  log.info(`Fetching offer data with hash ${order.ipfsHash}`)
  const offerData = await getText(ipfsGateway, order.ipfsHash, IPFS_TIMEOUT)
  const offer = JSON.parse(offerData)
  log.info('Payment Code', offer.paymentCode)

  // Load the external payment data to get the payment intent.
  const externalPayment = await ExternalPayment.findOne({
    where: {
      paymentCode: offer.paymentCode
    },
    attributes: ['payment_code', 'payment_intent']
  })
  if (!externalPayment) {
    throw new Error(
      `Failed loading external payment with code ${offer.paymentCode}`
    )
  }

  const paymentIntent = externalPayment.get({ plain: true }).payment_intent
  if (!paymentIntent) {
    throw new Error(
      `Missing payment_intent in external payment with id ${externalPayment.id}`
    )
  }
  log.info('Payment Intent', paymentIntent)

  // Call Stripe to perform the refund.
  const stripe = Stripe(shopConfig.stripeBackend)
  const piRefund = await stripe.refunds.create({
    payment_intent: paymentIntent
  })

  const refundError = piRefund.reason
  if (refundError) {
    // If stripe returned an error, log it but do not throw an exception.
    // TODO: finer grained error handling. Some reasons might be retryable.
    log.error(
      `Stripe refund for payment intent ${paymentIntent} failed: ${refundError}`
    )
    return refundError
  }

  log.info('Payment refunded')
  return null
}

/**
 * Processes a blockchain event for an order already recorded in the system.
 *
 * TODO:
 *  - This method assumes blockchain events are always processed in order.
 * We should add safeguards based on the current status of the order before
 * running any logic and updating the status.
 *  - As opposed to updating the order row, it would be better to consider the
 *  orders table as append-only and insert a new row every time an order is
 *  updated. This way we would have an auditable log of the changes.
 *
 * @param {models.Event} event: Event DB object.
 * @param {models.Order} order: Order DB object.
 * @returns {Promise<models.Order>} The updated order.
 * @throws {Error}
 * @private
 */
async function _processEventForExistingOrder({ event, shop, order }) {
  const eventName = event.eventName

  const updatedFields = {
    statusStr: eventName,
    updatedBlock: event.blockNumber
  }

  if (eventName === 'OfferWithdrawn') {
    // If it's a Stripe payment, initiate a refund.
    const paymentMethod = get(order, 'data.paymentMethod.id')
    if (paymentMethod === 'stripe') {
      const refundError = await _processStripeRefund({ event, shop, order })
      // Store the refund error in the order's data JSON.
      updatedFields.data = {
        ...order.data,
        refundError
      }
    }
  }

  // Update the order in the DB and return it.
  await order.update(updatedFields)
  return order
}

/**
 * Processes a blockchain event for a new order that has not been recorded yet in the system.
 *
 * @param {models.Event} event: Event DB object.
 * @param {string} offerId: fully qualified offer id.
 * @param {models.Shop} shop: SHop DB object.
 * @param {boolean} skipEmail: whether to skip sending a notification email to the merchant and buyer.
 * @param {boolean} skipDiscord: whether to skip sending a discord notification.
 * @returns {Promise<models.Order>} Newly created order.
 * @throws {Error}
 * @private
 */
async function _processEventForNewOrder({
  event,
  offerId,
  shop,
  skipEmail,
  skipDiscord
}) {
  const eventName = event.eventName

  // We expect the event to be an offer creation.
  if (eventName !== 'OfferCreated') {
    throw new Error(`Unexpected event ${eventName} for offerId ${offerId}.`)
  }
  log.info(`${eventName} - ${event.offerId} by ${event.party}`)
  log.info(`IPFS Hash: ${event.ipfsHash}`)

  const network = await Network.findOne({ where: { active: true } })
  const networkConfig = getConfig(network.config)

  // Load the shop configuration to read things like IPFS gateway to use.
  const shopConfig = getConfig(shop.config)
  const { dataUrl } = shopConfig
  const ipfsGateway = await getIPFSGateway(dataUrl, event.networkId)
  log.info(`Using IPFS gateway ${ipfsGateway} for fetching offer data`)

  // Load the offer data. The main thing we are looking for is the IPFS hash
  // of the encrypted data.
  log.info(`Fetching offer data with hash ${event.ipfsHash}`)
  const offerData = await getText(ipfsGateway, event.ipfsHash, IPFS_TIMEOUT)
  const offer = JSON.parse(offerData)
  log.debug('Offer:', offer)

  // Extract the optional paymentCode data from the offer.
  // It is populated for example in case of a Credit Card payment.
  const paymentCode = offer.paymentCode

  // Load the encrypted data from IPFS and decrypt it.
  const encryptedHash = offer.encryptedData
  if (!encryptedHash) {
    throw new Error('No encrypted data found')
  }
  log.info(`Fetching encrypted offer data with hash ${encryptedHash}`)
  const data = await decryptShopOfferData(shop, encryptedHash)

  // Decorate the data with a few extra fields before storing it in the DB.
  data.offerId = offerId
  data.tx = event.transactionHash

  // Insert a new row in the orders DB table.
  const orderObj = {
    networkId: event.networkId,
    shopId: shop.id,
    orderId: offerId,
    data,
    statusStr: eventName,
    updatedBlock: event.blockNumber,
    createdAt: new Date(event.timestamp * 1000),
    createdBlock: event.blockNumber,
    ipfsHash: event.ipfsHash,
    encryptedIpfsHash: encryptedHash,
    paymentCode
  }
  if (data.referrer) {
    orderObj.referrer = util.toChecksumAddress(data.referrer)
    orderObj.commissionPending = Math.floor(data.subTotal / 200)
  }
  const { valid, error } = await validateDiscountOnOrder(orderObj, {
    markIfValid: true
  })
  if (!valid) {
    orderObj.data.error = error
  }
  const order = await Order.create(orderObj)
  log.info(`Saved order ${order.orderId} to DB.`)

  // TODO: move order fulfillment to a queue.
  if (shopConfig.printful && shopConfig.printfulAutoFulfill) {
    await autoFulfillOrder(order, shopConfig, shop)
  }

  // Send notifications via email and discord.
  // This section is not critical so we log errors but do not throw any
  // exception in order to avoid triggering a queue retry which would
  // cause the order to get recorded multiple times in the DB.
  if (!skipEmail) {
    try {
      await sendNewOrderEmail({ shop, cart: data, network })
    } catch (e) {
      log.error('Email sending failure:', e)
      Sentry.captureException(e)
    }
  }
  if (!skipDiscord) {
    try {
      await discordWebhook({
        url: networkConfig.discordWebhook,
        orderId: offerId,
        shopName: shop.name,
        total: `$${(data.total / 100).toFixed(2)}`,
        items: data.items.map((i) => i.title).filter((t) => t)
      })
    } catch (e) {
      log.error('Discord webhook failure:', e)
      Sentry.captureException(e)
    }
  }

  return order
}

/**
 * Logic for processing ListingCreated event.
 *
 * @param {models.Event} event
 * @returns {Promise<null||models.Shop>}
 * @private
 */
async function _processEventListingCreated({ event }) {
  // Get the address of the wallet that submitted the event.
  const walletAddress = event.party

  // Lookup for any shop linked to that address and that does not have a listingId yet.
  // There could be more than one if the merchant created multiple shops
  // using the same wallet. We pick the most recently updated shop.
  const shop = await Shop.findOne({
    where: { walletAddress, listingId: null },
    order: [['updatedAt', 'desc']]
  })
  if (!shop) {
    // Ignore the event. It could be a ListingCreated event unrelated to Dshop
    // or a merchant that submitted by mistake multiple createListing transactions.
    log.info(`No shop found associated with wallet address ${walletAddress}`)
    return null
  }

  // Get the fully-qualified listing ID.
  const listingId = new ListingID(event.listingId, shop.networkId).toString()

  // Associate the listing Id with the shop in the DB.
  await shop.update({ listingId })
  log.info(`Associated shop ${shop.id} with listing Id ${listingId}`)

  // Load the shop's config.json from the deploy staging area.
  const dataDir = shop.authToken
  const shopDir = `${DSHOP_CACHE}/${dataDir}`
  const shopConfigPath = `${shopDir}/data/config.json`
  log.debug(`Shop ${shop.id}: Loading config at ${shopConfigPath}`)
  const raw = fs.readFileSync(shopConfigPath)
  const shopConfig = JSON.parse(raw.toString())

  // Update the config.json listingId field and write it back to disk.
  const netPath = `networks[${shop.networkId}]`
  set(shopConfig, `${netPath}.listingId`, listingId)
  fs.writeFileSync(shopConfigPath, JSON.stringify(shopConfig, null, 2))
  log.info(
    `Shop ${shop.id}: set listingId to ${listingId} in config at ${shopConfigPath}`
  )

  return shop
}

/**
 * Processes a dshop event
 * @param {string} listingId: fully qualified listing id
 * @param {models.Event} event: Event DB object.
 * @param {models.Shop} shop: Shop DB object or null.
 * @param {boolean} skipEmail: do not send any email. Useful for ex. when
 *   reprocessing events, to avoid sending duplicate emails to the users.
 * @param {boolean} skipDiscord: do not call the Discord webhook. Useful
 *   for ex. when reprocessing events.
 * @returns {Promise<models.Shop|models.Order|null} Shop or Order DB object or null if the event did not
 *   Null in case the event did not need to get processed.
 */
async function processDShopEvent({ event, shop, skipEmail, skipDiscord }) {
  const eventName = event.eventName

  if (eventName === 'ListingCreated') {
    const shop = await _processEventListingCreated({ event })
    return shop
  }

  // Skip any event that is not offer related.
  if (eventName.indexOf('Offer') < 0) {
    log.info(
      `Not a ListingCreated neither an Offer event. Ignoring ${eventName}`
    )
    return null
  }

  // If it's an Offer event, we expect a shop to have been loaded and we expect
  // the shop to have a listingId.
  if (!shop) {
    log.info(`No shop associated with event ${eventName}. Skipping.`)
    return
  }
  if (!shop.listingId) {
    throw new Error(
      `No listingId associated with shop ${shop.id}. Processing of event ${eventName} failed.`
    )
  }

  // Construct a fully-qualified offerId.
  const offerId = `${shop.listingId}-${event.offerId}`

  // Load any existing order associated with this blockchain offer.
  let order = await Order.findOne({
    where: {
      networkId: event.networkId,
      shopId: shop.id,
      orderId: offerId
    }
  })

  if (order) {
    // Existing order.
    order = await _processEventForExistingOrder({ event, shop, order })
  } else {
    // New order.
    order = await _processEventForNewOrder({
      event,
      offerId,
      shop,
      skipEmail,
      skipDiscord
    })
  }

  return order
}

module.exports = {
  handleLog,
  processDShopEvent
}
