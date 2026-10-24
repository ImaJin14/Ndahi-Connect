import { json } from './http.mjs';
import { NOT_HANDLED } from './routing.mjs';
import { connectivityState } from '../connectivity-state.mjs';
export function createConnectivityRoutes({ mutate, auth, coverage, clock }) {
  return async (req, res, url) => {
    if (url.pathname !== '/api/account/connectivity') return NOT_HANDLED;
    if (req.method !== 'GET') return json(res, 405, { error: 'GET required.' });
    res.setHeader('cache-control','no-store');
    return mutate(s => json(res,200,connectivityState(s,{ session: auth(req,s,'dashboardSessions'), ingress: coverage.access(req).allowed, coverageEnabled: coverage.enabled, now: clock() })),{res});
  };
}
