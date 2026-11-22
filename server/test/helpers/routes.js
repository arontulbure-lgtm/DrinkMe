// The route list behind test/route-coverage.test.js and test/route-gates.test.js.
//
// readServerRoutes() reads every route registered in server.js from its source text (server.js does
// not export the app, and starting it only to walk the router would need a change there).
// ROUTE_MANIFEST is maintained by hand: when you add a route to server.js, add it here with the test
// files that exercise it and the gates it must apply, or route-coverage.test.js fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEST_DIR = path.join(SERVER_DIR, 'test');
const SERVER_FILE = path.join(SERVER_DIR, 'server.js');

const ROUTE_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
// Any registration call, whatever its first argument. Compared with the literal ones below, so a route
// registered with a variable or template path cannot slip past the guard.
const ANY_REGISTRATION = /\bapp\.(get|post|put|patch|delete|all|head|options|route)\s*\(/g;
const LITERAL_ROUTE = /\bapp\.(get|post|put|patch|delete)\s*\(\s*(['"])([^'"`$]+)\2/g;
// app.use with a path as its first argument: only these mounts are known middleware, never sub-routers.
const PATH_MOUNT = /\bapp\.use\s*\(\s*(['"`])([^'"`]*)\1/g;
export const KNOWN_MOUNT_PATHS = new Set(['/api', '/media']);

/** Strips comments, so a commented-out route neither counts nor hides. Strings are kept as they are. */
const stripComments = (source) => {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '\'' || ch === '"' || ch === '`') quote = ch;
    out += ch;
    i += 1;
  }
  return out;
};

/**
 * @returns {{
 *   routes: { method: string, path: string, key: string }[],
 *   registrationCount: number,
 *   unknownMounts: string[],
 *   usesExpressRouter: boolean,
 * }}
 */
export function readServerRoutes() {
  return parseRoutes(fs.readFileSync(SERVER_FILE, 'utf8'));
}

/** Same as readServerRoutes, for any source text (the guard tests itself with this). */
export function parseRoutes(sourceText) {
  // Regex literals in server.js (for example /^\/api\/auth\/mobile\/?$/i) contain no quote characters
  // that open a string, so the simple string tracking in stripComments stays in sync.
  const source = stripComments(sourceText);
  const routes = [];
  for (const match of source.matchAll(LITERAL_ROUTE)) {
    const method = match[1].toUpperCase();
    routes.push({ method, path: match[3], key: `${method} ${match[3]}` });
  }
  const unknownMounts = [...source.matchAll(PATH_MOUNT)]
    .map((match) => match[2])
    .filter((mount) => !KNOWN_MOUNT_PATHS.has(mount));
  return {
    routes,
    registrationCount: [...source.matchAll(ANY_REGISTRATION)].length,
    unknownMounts,
    usesExpressRouter: /\bexpress\.Router\s*\(|\bRouter\s*\(\s*\)/.test(source),
  };
}

/**
 * gate:
 *   'public'         no JWT needed (requireSignedInAdult lets it through for everyone)
 *   'own-before-age' needs a JWT; open before the 18+ confirmation only when :id is the caller
 *   'adult'          needs a JWT and the 18+ confirmation (the default for every new route)
 *   'dev-only'       registered only when NODE_ENV=development (device test sessions); absent in test and
 *                    production mode, so route-gates.test.js checks a 404 instead of the gates. Path under /__dev/.
 * suspended: true when a suspended caller must get 403 account_suspended.
 * admin: true when only ADMIN_USER_IDS may call it (403 otherwise).
 * files: test files (in server/test) that exercise the route. Each must name the route's path.
 */
export const ROUTE_MANIFEST = {
  'GET /healthz': { gate: 'public', files: ['harness.test.js', 'sign-in-gate.test.js', 'production-guard.test.js'] },
  'GET /media/drinks/:id': { gate: 'adult', files: ['media-pages.test.js', 'age-gate.test.js', 'sign-in-gate.test.js', 'route-gates.test.js'] },
  'GET /media/avatars/:userId': { gate: 'adult', files: ['media-pages.test.js', 'moderation-decisions.test.js', 'sign-in-gate.test.js', 'route-gates.test.js'] },

  'POST /api/auth/mobile': { gate: 'public', files: ['auth.test.js', 'account-takeover.test.js', 'email-verification.test.js', 'sign-in-gate.test.js', 'password-reset-session.test.js'] },
  'POST /api/account/delete-unverified': { gate: 'public', files: ['email-verification.test.js', 'sign-in-gate.test.js'] },

  'GET /api/users/search': { gate: 'adult', files: ['email-exposure.test.js', 'null-user.test.js', 'onboarding.test.js', 'route-gates.test.js'] },
  'GET /api/users/:id': { gate: 'own-before-age', files: ['email-exposure.test.js', 'onboarding.test.js', 'sign-in-gate.test.js', 'route-gates.test.js'] },
  'GET /api/users/:id/partners': { gate: 'adult', files: ['partners.test.js', 'email-exposure.test.js', 'route-gates.test.js'] },
  'PUT /api/users/:id': { gate: 'own-before-age', suspended: true, files: ['plain-text.test.js', 'moderation-decisions.test.js', 'sign-in-gate.test.js', 'route-gates.test.js'] },
  'POST /api/users/:id/acknowledgements': { gate: 'own-before-age', files: ['onboarding.test.js', 'audit-log.test.js', 'sign-in-gate.test.js', 'route-gates.test.js'] },
  'POST /api/users/:id/avatar': { gate: 'adult', suspended: true, files: ['images.test.js', 'storage-limits.test.js', 'moderation-decisions.test.js', 'route-gates.test.js'] },
  'POST /api/users/:id/delete-account': { gate: 'own-before-age', files: ['account-deletion.test.js', 'sign-in-gate.test.js', 'route-gates.test.js'] },
  'GET /api/users/:userId/saved-drinks': { gate: 'adult', files: ['saved-drinks.test.js', 'media-pages.test.js', 'route-gates.test.js'] },

  'GET /api/drink-partners': { gate: 'adult', files: ['partners.test.js', 'qa-flows.test.js', 'route-gates.test.js'] },
  'GET /api/drink-partners/requests': { gate: 'adult', files: ['partners.test.js', 'route-gates.test.js'] },
  'POST /api/drink-partners/requests/:fromId/accept': { gate: 'adult', suspended: true, files: ['partners.test.js', 'moderation-decisions.test.js', 'route-gates.test.js'] },
  'DELETE /api/drink-partners/requests/:fromId': { gate: 'adult', files: ['partners.test.js', 'moderation-decisions.test.js', 'route-gates.test.js'] },
  'POST /api/drink-partners/:targetId': { gate: 'adult', suspended: true, files: ['partners.test.js', 'moderation-decisions.test.js', 'route-gates.test.js'] },
  'DELETE /api/drink-partners/:targetId': { gate: 'adult', files: ['partners.test.js', 'route-gates.test.js'] },
  'GET /api/friends/count': { gate: 'adult', files: ['partners.test.js', 'account-deletion.test.js', 'route-gates.test.js'] },

  'GET /api/stories': { gate: 'adult', files: ['null-user.test.js', 'sign-in-gate.test.js', 'route-gates.test.js'] },

  'GET /api/drinks': { gate: 'adult', files: ['media-pages.test.js', 'categories.test.js', 'age-gate.test.js', 'route-gates.test.js'] },
  'GET /api/drinks/partners': { gate: 'adult', files: ['partners.test.js', 'qa-flows.test.js', 'media-pages.test.js', 'route-gates.test.js'] },
  'GET /api/drinks/user/:userId': { gate: 'adult', files: ['media-pages.test.js', 'age-gate.test.js', 'route-gates.test.js'] },
  'GET /api/drinks/:id': { gate: 'adult', files: ['age-gate.test.js', 'moderation-decisions.test.js', 'qa-flows.test.js', 'route-gates.test.js'] },
  'GET /api/drinks/:id/comments': { gate: 'adult', files: ['moderation.test.js', 'media-pages.test.js', 'route-gates.test.js'] },
  'POST /api/drinks/:id/comments': { gate: 'adult', suspended: true, files: ['storage-limits.test.js', 'qa-security.test.js', 'moderation-decisions.test.js', 'route-gates.test.js'] },
  'DELETE /api/drinks/:id/comments/:commentId': { gate: 'adult', files: ['moderation-decisions.test.js', 'moderation.test.js', 'route-gates.test.js'] },
  'POST /api/drinks': { gate: 'adult', suspended: true, files: ['images.test.js', 'storage-limits.test.js', 'categories.test.js', 'route-gates.test.js'] },
  'DELETE /api/drinks/:id': { gate: 'adult', files: ['delete-post.test.js', 'qa-security.test.js', 'route-gates.test.js'] },
  'PUT /api/drinks/:id': { gate: 'adult', suspended: true, files: ['edit-post.test.js', 'route-gates.test.js'] },
  'POST /api/drinks/:id/like': { gate: 'adult', files: ['toggles.test.js', 'moderation.test.js', 'route-gates.test.js'] },
  'POST /api/drinks/:id/save': { gate: 'adult', files: ['toggles.test.js', 'saved-drinks.test.js', 'route-gates.test.js'] },

  'GET /api/notifications': { gate: 'adult', files: ['notifications-i18n.test.js', 'qa-flows.test.js', 'route-gates.test.js'] },
  'POST /api/notifications/read': { gate: 'adult', files: ['partners.test.js', 'moderation.test.js', 'route-gates.test.js'] },

  'GET /api/smart-bar': { gate: 'adult', files: ['smart-bar.test.js', 'route-gates.test.js'] },
  'POST /api/smart-bar': { gate: 'adult', files: ['smart-bar.test.js', 'storage-limits.test.js', 'route-gates.test.js'] },
  'DELETE /api/smart-bar/:itemId': { gate: 'adult', files: ['smart-bar.test.js', 'storage-limits.test.js', 'route-gates.test.js'] },

  'GET /api/blocks': { gate: 'adult', files: ['moderation.test.js', 'route-gates.test.js'] },
  'POST /api/blocks/:targetId': { gate: 'adult', files: ['moderation.test.js', 'partners.test.js', 'route-gates.test.js'] },
  'DELETE /api/blocks/:targetId': { gate: 'adult', files: ['moderation.test.js', 'route-gates.test.js'] },

  'POST /api/reports': { gate: 'adult', suspended: true, files: ['moderation.test.js', 'moderation-decisions.test.js', 'route-gates.test.js'] },
  'GET /api/admin/reports': { gate: 'adult', admin: true, files: ['moderation.test.js', 'moderation-decisions.test.js', 'route-gates.test.js'] },
  'POST /api/admin/reports/:id/resolve': { gate: 'adult', admin: true, files: ['moderation.test.js', 'moderation-decisions.test.js', 'route-gates.test.js'] },
  'POST /api/admin/users/:id/suspend': { gate: 'adult', admin: true, files: ['moderation-decisions.test.js', 'audit-log.test.js', 'route-gates.test.js'] },
  'POST /api/admin/users/:id/unsuspend': { gate: 'adult', admin: true, files: ['moderation-decisions.test.js', 'audit-log.test.js', 'route-gates.test.js'] },
  'GET /api/admin/audit': { gate: 'adult', admin: true, files: ['audit-log.test.js', 'route-gates.test.js'] },


  'GET /api/ai/status': { gate: 'adult', files: ['ai-v1.test.js', 'route-gates.test.js'] },
  'POST /api/ai/notice': { gate: 'adult', files: ['ai-v1.test.js', 'route-gates.test.js'] },
  'PUT /api/ai/settings': { gate: 'adult', files: ['ai-v1.test.js', 'route-gates.test.js'] },
  'POST /api/ai/scan': { gate: 'adult', files: ['ai-v1.test.js', 'route-gates.test.js'] },
  'POST /api/ai/barcode': { gate: 'adult', files: ['ai-v1.test.js', 'route-gates.test.js'] },
  'POST /api/ai/recipes': { gate: 'adult', files: ['ai-v1.test.js', 'route-gates.test.js'] },
  'GET /api/recipes/saved': { gate: 'adult', files: ['ai-v1.test.js', 'route-gates.test.js'] },
  'POST /api/recipes/saved': { gate: 'adult', files: ['ai-v1.test.js', 'route-gates.test.js'] },
  'DELETE /api/recipes/saved/:recipeId': { gate: 'adult', files: ['ai-v1.test.js', 'route-gates.test.js'] },
  'POST /api/ai/report': { gate: 'adult', files: ['ai-v1.test.js', 'route-gates.test.js'] },

  'POST /__dev/client-log': { gate: 'dev-only', files: ['dev-log-bridge.test.js', 'route-gates.test.js'] },
};

/** The fixed parts of a route path, without edge slashes: '/api/users/:id/avatar' gives ['api/users', 'avatar']. */
export const staticParts = (routePath) => (
  routePath.split(/:[A-Za-z_]\w*/).map((part) => part.replace(/^\/+|\/+$/g, '')).filter(Boolean)
);

/** Names of the path parameters, in order. */
export const paramNames = (routePath) => [...routePath.matchAll(/:([A-Za-z_]\w*)/g)].map((match) => match[1]);

/** Fills a route path (values are used as given, not encoded). values maps a parameter name to its value; anything missing uses fallback(name). */
export const fillPath = (routePath, values = {}, fallback = () => 'x') => (
  routePath.replace(/:([A-Za-z_]\w*)/g, (_, name) => String(values[name] ?? fallback(name)))
);
