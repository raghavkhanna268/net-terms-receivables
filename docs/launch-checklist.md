# Launch Checklist

Pre-launch tasks for the Net Terms Receivables app.

## Security

- [ ] **Before S24**: Audit requested scopes and drop any that no merged code uses. See `docs/scopes.md` for the current scope list and justifications.

## Compliance

- [ ] Protected customer data requirements met
- [ ] GDPR/CCPA compliance webhooks implemented (customers/data_request, customers/redact, shop/redact)

## Infrastructure

- [ ] Production database provisioned
- [ ] Hyperdrive configuration updated for production
- [ ] Secrets configured in Cloudflare Workers

## Testing

- [ ] All integration tests passing
- [ ] Manual QA on dev store complete
- [ ] Load testing performed (if applicable)
