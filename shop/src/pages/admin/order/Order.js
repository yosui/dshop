import React from 'react'
import { NavLink, useRouteMatch, Switch, Route } from 'react-router-dom'

import get from 'lodash/get'
import fbt from 'fbt'

import useOrder from 'utils/useOrder'
import { useStateValue } from 'data/state'

import Link from 'components/Link'

import OrderDetails from './Details'
import Printful from './Printful'
import Contract from './Contract'

const AdminOrder = () => {
  const match = useRouteMatch('/admin/orders/:orderId/:tab?')
  const { orderId, tab } = match.params
  const { order, loading } = useOrder(orderId)
  const [{ admin }] = useStateValue()
  const urlPrefix = `/admin/orders/${orderId}`

  const offerSplit = orderId.split('-')
  const listingId = offerSplit.slice(0, -1).join('-')
  const offerId = Number(offerSplit[offerSplit.length - 1])

  return (
    <>
      <h3 className="admin-title">
        <Link to="/admin/orders" className="muted">
          <fbt desc="Orders">Orders</fbt>
        </Link>
        <span className="chevron" />
        {`Order #${orderId}`}
        <div style={{ fontSize: 18 }} className="actions">
          <Link
            to={`/admin/orders/${listingId}-${offerId - 1}${
              tab ? `/${tab}` : ''
            }`}
          >
            &lt; <fbt desc="Older">Older</fbt>
          </Link>
          <Link
            to={`/admin/orders/${listingId}-${offerId + 1}${
              tab ? `/${tab}` : ''
            }`}
          >
            <fbt desc="Newer">Newer</fbt> &gt;
          </Link>
        </div>
      </h3>
      {!get(order, 'data.error') ? null : (
        <div className="alert alert-danger">{order.data.error}</div>
      )}
      <ul className="nav nav-tabs mt-3 mb-4">
        <li className="nav-item">
          <NavLink className="nav-link" to={urlPrefix} exact>
            <fbt desc="Details">Details</fbt>
          </NavLink>
        </li>
        {admin.role !== 'admin' ? null : (
          <li className="nav-item">
            <NavLink className="nav-link" to={`${urlPrefix}/printful`}>
              Printful
            </NavLink>
          </li>
        )}
        {admin.role !== 'admin' ? null : (
          <li className="nav-item">
            <NavLink className="nav-link" to={`${urlPrefix}/contract`}>
              <fbt desc="Contract">Contract</fbt>
            </NavLink>
          </li>
        )}
      </ul>
      {loading ? (
        <>
          <fbt desc="Loading">Loading</fbt>...
        </>
      ) : (
        <Switch>
          <Route path={`${urlPrefix}/printful`}>
            <Printful />
          </Route>
          <Route path={`${urlPrefix}/contract`}>
            <Contract order={order} />
          </Route>
          <Route>
            <OrderDetails order={order} />
          </Route>
        </Switch>
      )}
    </>
  )
}

export default AdminOrder

require('react-styl')(`
  .nav-tabs
    .nav-link
      padding: 0.5rem 0.25rem
      margin-right: 2rem
      border-width: 0 0 4px 0
      color: #666666
      &:hover
        border-color: transparent
      &.active
        border-color: #3b80ee
        color: #000
`)
