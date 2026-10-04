import { FakeServer, type FakeResponse } from './FakeServer.js';

/**
 * Impersonates a protected application endpoint (WordPress, Nextcloud, ...)
 * as seen through a site's NPM. Each path returns a configurable response and
 * every response carries the site marker header.
 */
export class FakeApp extends FakeServer {
  routes = new Map<string, FakeResponse>();
  down = false;
  /** Optional liveness predicate, e.g. "the VM behind this app is running". */
  upWhen: (() => boolean) | null = null;

  constructor(public siteMarker: string) {
    super((req): FakeResponse => {
      if (this.down || (this.upWhen && !this.upWhen())) return { status: 502, body: '<html>502 Bad Gateway</html>', headers: { 'content-type': 'text/html' } };
      const r = this.routes.get(req.path) ?? { status: 404, body: 'not found' };
      return { ...r, headers: { 'x-served-by': this.siteMarker, ...(r.headers ?? {}) } };
    });
  }

  set(path: string, res: FakeResponse): this {
    this.routes.set(path, res);
    return this;
  }
}
