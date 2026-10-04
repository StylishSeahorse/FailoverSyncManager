import { HttpClient } from '../../src/http/client.js';
import { EgressGuard } from '../../src/http/egress.js';

/** HTTP client restricted to loopback, as in every test. */
export const testHttp = () => new HttpClient(new EgressGuard(['127.0.0.1', 'localhost']), 5000);
