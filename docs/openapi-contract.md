# OpenAPI contract maintenance

The OpenAPI document is source-controlled as `apps/api/src/openapi.ts` and served verbatim at `/openapi.json`. The runtime route inventory is declared alongside it as `API_ROUTE_KEYS`.

`tests/api.test.ts` enumerates the methods/paths from the OpenAPI object and requires exact equality with `API_ROUTE_KEYS`. Adding or removing an advertised endpoint without updating the contract causes the drift gate to fail.

The document intentionally describes the stable V1 control-plane surface rather than generated framework internals. Request runtime validation remains authoritative for workflow JSON semantics and payload bounds.
