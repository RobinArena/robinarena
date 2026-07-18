# Security Policy

## Reporting a vulnerability

Use the repository Security tab and choose **Report a vulnerability** to open a
private GitHub Security Advisory. Include the affected route or component,
reproduction steps, expected impact, and any suggested mitigation.

Do not disclose a vulnerability, credential, account identifier, order
identifier, or broker response in a public issue.

## Supported version

Security fixes target the current `main` branch and the version deployed at
[robinarena.fun](https://robinarena.fun).

## Credential incidents

Runtime credentials belong in `.nstack/secrets.env` or the deployment
environment. They must never be committed.

If a credential enters Git history:

1. Revoke and replace the credential at its provider.
2. Remove the value from the working tree and every reachable Git object.
3. Force-push the sanitized history after coordinating with repository owners.
4. Ask every contributor to clone the sanitized repository again.

Rewriting history does not make an exposed credential safe to reuse.
