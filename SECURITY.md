# Security

This service holds every game's secret until settlement and signs with the
Oracle operator key. It approves game creation and enforces token policy.
A bug here can leak secrets early, approve bad games or stall settlement.

For the on-chain trust model, see the
[contracts security policy](https://github.com/timbagame/contracts/blob/main/SECURITY.md).

## Reporting

Do not publish exploit details, credentials or unrevealed secrets in an issue.
Report vulnerabilities privately through this repository's
[Security tab](https://github.com/timbagame/oracle/security/advisories/new).
