# Private notes on AWS, through doxx.net

A small Hono/Node notes app on EC2, with PostgreSQL on RDS. The EC2 security group has **zero inbound rules**. An outbound WireGuard tunnel carries requests from a selected Mac on doxx.net.

**Status: Step 1 deployed on AWS and online verification passed on 2026-10-14. Offline verification, a clean rebuild after the startup fixes, and a benchmark baseline remain pending.** HTTPS and login are separate later stages in [the plan](plans/doxx-test-app-1.md). This version serves HTTP inside the tunnel and is for disposable test notes.

## Contents

1. [Architecture](#architecture)
2. [Prerequisites](#prerequisites)
3. [Build it](#build-it)
4. [Verify](#verify)
5. [Latency](#latency)
6. [API reference](#api-reference)
7. [Design decisions](#design-decisions)
8. [Troubleshooting](#troubleshooting)
9. [Costs and teardown](#costs-and-teardown)

## Architecture

```mermaid
flowchart LR
  M[Selected Mac tunnel] -->|WireGuard| D[doxx.net]
  E[EC2: no SG ingress] -->|Outbound WireGuard| D
  D -->|TCP 8080 inside established tunnel| A[Node bound to doxx IPv4]
  A -->|TLS / TCP 5432| R[RDS: private endpoint]
  E --- A
```

The app accepts only the configured Mac source IP and the exact Host header `<tunnel-ip>:8080`. Form Origins are checked against that fixed HTTP origin, which blocks DNS rebinding from a browser on the allowed Mac. Changing Mac tunnels requires rerunning provisioning and deployment. There is no application login yet. HTTP is carried by the doxx network; RDS traffic uses TLS with certificate verification.

Provisioning refuses Link All. It must remain disabled while this instance runs: Link All also lets the EC2 tunnel initiate connections to every other device on the account, on every port. Use the dedicated Mac-to-app TCP 8080 rule. A disabled rule owned by this project is recreated as active. An unowned matching disabled rule causes a clear error; enable or remove it yourself before retrying so provisioning preserves unowned rules.

```mermaid
sequenceDiagram
  participant E as EC2 boot
  participant S as SSM Parameter Store
  participant W as WireGuard
  participant A as Node service
  participant M as Secrets Manager
  participant R as RDS
  E->>S: Fetch SecureString using instance role
  E->>W: Install private config and start tunnel
  E->>E: Block notes UID from instance metadata
  E->>M: Root reads managed master DB credential
  E->>R: Verify TLS, initialize table and scoped app role
  E->>A: Start notes service with scoped credentials from /run
  A->>R: TLS connection as notes_app
```

## Prerequisites

| Requirement | Check / setup |
|---|---|
| Node 22.9+ or 24 and npm | `node --version`; locally tested with Node 24.17.0 |
| Terraform 1.13.x or newer, below 2 | `terraform version`; locally tested with 1.13.2 |
| AWS CLI v2 and default credentials | `aws sts get-caller-identity`; requires EC2, IAM, RDS, SSM and Secrets Manager permissions |
| WireGuard on the Mac | `wg --version`; create and connect a separate Mac tunnel |
| curl, jq, tar, Bash | `make check` checks availability |
| doxx account and available tunnel seat | [Account portal](https://a0x13.doxx.net/); signup and subscription/trial are manual |
| doxx net-admin token | Dedicated expiring token with an IP fence; place only in private `.env` or environment |
| Default VPC in us-east-1 | Must use `172.31.0.0/16`, public outbound routing, and subnets in at least two availability zones |

No application Docker build is needed. AWS boot installs the versioned `nodejs22` packages; see [Amazon Linux's Node documentation](https://docs.aws.amazon.com/linux/al2023/ug/nodejs.html).

Use a dedicated `net-admin` token with a short expiration and an IP fence for the address from which you call the API. For a pre-existing app tunnel, scope the token to that tunnel and the selected Mac. New tunnel creation may need an initially broader provisioning token; an account admin can add the new tunnel scope afterward. Revoke the provisioning token after provisioning. Use a scoped read-only token for live verification, and issue a fresh short-lived net-admin token for reprovisioning or teardown. Token creation, fencing, scoping and revocation are documented in the [doxx token reference](https://github.com/doxxcorp/config.doxx.net/blob/main/docs/endpoints/tokens.md).

## Build it

### Local implementation checks (no infrastructure changes)

```sh
make install
make test
bash scripts/package.sh
terraform -chdir=infra init -backend=false
make validate
make test-infra
make security-check
```

The application and provider versions are locked in `app/package-lock.json` and `infra/.terraform.lock.hcl`. Packaging includes only five explicitly named app files; it cannot pick up `.env`, cloud credentials, or local results. The bundle size check reserves space within EC2's user-data limit. To additionally test database grants against an isolated local PostgreSQL server, install its `initdb`/`pg_ctl` tools and run `RUN_LOCAL_POSTGRES_TESTS=1 make test`; this starts a temporary server using a Unix socket with TCP disabled.

### Provision and deploy

These steps create billable resources and consume one doxx seat. Deployment and online verification have been completed for this checkout; a full teardown/rebuild cycle remains pending.

```sh
cp .env.example .env
chmod 600 .env
cp infra/terraform.tfvars.example infra/terraform.tfvars
# Edit .env with your temporary net-admin token, server and existing Mac tunnel name.
make servers
make tunnels
make check
make provision
make deploy
```

`make servers` shows public locations. Select a server near the AWS region explicitly; the script does not guess from hostnames. `make tunnels` displays names and connection state without keys or tokens. Connect the chosen Mac tunnel before verification. Do not paste credentials into chat or commit the populated configuration.

| Target | Raw command / behavior |
|---|---|
| `make check` | `bash scripts/check.sh`; read-only tool/config/credential preflight |
| `make provision` | `bash scripts/doxx-provision.sh`; tunnel, SecureString, per-pair rule, private deployment inputs |
| `make deploy` | `bash scripts/deploy.sh`; package, init, saved plan, explicit apply prompt |
| `make verify` | `bash scripts/verify.sh`; online checks, temporary test note and service restart |
| `make verify-offline` | `bash scripts/verify.sh --offline`; run after manually disconnecting the Mac tunnel |
| `make latency` | `node --env-file-if-exists=.env --test --test-concurrency=1 tests/latency/*.test.mjs` |
| `make report` | `node scripts/latency-report.mjs`; requires a reviewed real baseline |
| `make destroy` | `bash scripts/destroy.sh`; saved destruction plan, prompt, AWS deletion, then doxx cleanup |

```mermaid
flowchart LR
  C[check] --> P[provision] --> D[deploy] --> V[verify] --> L[latency] --> R[report] --> X[destroy]
  X --> B[Later: rebuild from README]
```

Provisioning records ownership in `.local/provision.json` with mode 0600. Repeated runs reuse the named tunnel and owned SSM parameter, skip active existing firewall rules, and preserve account-wide settings. A pre-existing tunnel is borrowed, not deleted at teardown. Duplicate names, changed account/region, or an unowned SSM parameter cause an error. Keep the private journal until cleanup is finished. A crash between an API mutation and its journal update can leave an untracked resource: inspect it manually; never delete it merely because its name matches.

The WireGuard endpoint's IPv4 address is resolved during provisioning and pinned in both the private WireGuard config and Terraform inputs. Egress permits UDP only to that address and endpoint port, TCP 5432 only to the DB security group, and TCP 443 for AWS APIs, package downloads and the RDS CA. If the doxx endpoint address changes or becomes unavailable, rerun provisioning and deployment to refresh it.

<details>
<summary>Configuration reference</summary>

Environment values are read by Node's env-file loader; `.env` is not executed as shell code. Existing environment values take precedence.

| Variable | Default | Meaning |
|---|---|---|
| `DOXX_TOKEN` | required | Temporary scoped net-admin credential for changes; read-only for verification; never sent to AWS |
| `AWS_REGION` | `us-east-1` | AWS deployment region |
| `DOXX_TUNNEL_NAME` | `aws-test-app` | Dedicated instance tunnel name |
| `DOXX_SERVER` | required | Exact discovered server hostname |
| `DEVICE_TUNNEL_NAME` | required | Existing Mac tunnel, selectable before provisioning |
| `WG_PARAMETER_NAME` | `/doxx-test-app/wg-conf` | SecureString owned by this project |
| `DOXX_ALLOWED_IPS` | `10.0.0.0/8,2602:f5c1:1::/48` | Doxx-only routes; excludes AWS VPC and default route |
| `WG_MTU` | `1380` | Conservative starting MTU, live validation still needed |
| `DIRECT_BASELINE_CONFIRMED` | unset | Set `1` only after verifying the regional baseline bypasses the Mac's doxx tunnel |
| `project_name` (Terraform) | `doxx-test-app` | Resource names and tags |
| `postgres_version` (Terraform) | `17` | PostgreSQL major version; automatic minor upgrades enabled |
| `ami_id` (Terraform) | `null` | Latest AL2023 x86_64; replace with recorded output to reproduce exactly |
| `aws_region`, `wg_parameter_name` (Terraform) | above | Written by provisioning |
| `tunnel_ip`, `client_ip` (Terraform) | required | Written by provisioning; no private keys |
| `tunnel_endpoint_ips`, `tunnel_endpoint_port` (Terraform) | required | Resolved endpoint and UDP port written by provisioning |

`infra/generated.auto.tfvars.json` is private and overrides matching values in `terraform.tfvars`. Change region, parameter, or Mac selection through `.env`, not by editing the generated file. Default AWS credential resolution is used; standard `AWS_PROFILE` is supported if intentionally set.

The environment file contains `BIND_HOST`, `CLIENT_IP`, `AWS_REGION`, `DB_HOST`, `DB_SECRET_ARN`, `DB_CREDENTIALS_FILE`, and `DB_CA_FILE`. These are references and addresses. Root startup code fetches the managed master password, initializes the table, and sets a random password for the `notes_app` role. That role receives only SELECT/INSERT/DELETE on `notes`, sequence access, and connection/schema usage. Its credentials are written to a root-owned 0640 file under `/run/doxx-app`, readable by the `notes` group. The app reads this file and does not call AWS. Root installs an iptables owner rule before every service start to block IMDS access for the `notes` UID; IPv6 IMDS is disabled. No sensitive SSM value is read by Terraform.

PostgreSQL stays within major version 17 by default. RDS applies its designated automatic minor upgrade during the maintenance window; this does not guarantee every newly published minor release is selected immediately. See the [RDS automatic upgrade policy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_UpgradeDBInstance.PostgreSQL.Minor.html).

</details>

## Verify

`make verify` checks the app security group, DB security group, private RDS flag, connected instance tunnel, disabled Link All, active Mac-to-app rule, page access, reported caller IP, notes persistence across a service restart, and blocked public TCP 8080. Through SSM it checks the IMDS owner rule and confirms root can request an IMDSv2 token while `notes` cannot reach IMDS; token output is discarded. It removes its own test note. It requires permission to send SSM commands and leaves other notes intact.

Then disconnect the Mac tunnel, run `make verify-offline`, and reconnect it. A failed connection on its own is not evidence of isolation; combine it with the successful connected test and security group inspection. Automatic tunnel switching is deliberately not performed.

For a manual note test, open the page and submit its form. Raw POSTs require the form's CSRF token. The cleanup route `POST /notes/:id/delete` has the same source-IP and CSRF checks.

| Test | Local status / live purpose |
|---|---|
| App security tests | Local: escaping, parameterized writes, body bounds, CSRF, caller-IP and fixed Host/Origin checks, sanitized errors |
| AWS CLI input tests | Local skeleton validation: private-file input and cleanup on success/failure; no AWS requests |
| Provisioning lifecycle tests | Local mocks: idempotency, owned cleanup, borrowed resources, Link All refusal, owned parked rule repair, unowned parked rule refusal |
| Terraform plan test | Mock provider: zero ingress, scoped egress, private encrypted RDS, automatic minor upgrades, IMDSv2; no AWS calls |
| Database privilege test | Optional isolated local PostgreSQL: CRUD permissions, denied schema/admin changes, idempotent initialization |
| Secret scanner test | Local: baseline is scanned and secret values are suppressed |
| Config renderer tests | Local: valid split routes, rejection of injected WireGuard fields |
| Percentile/report tests | Local: known percentiles, light/dark SVG and table generation |
| `make verify` | Passed against AWS on 2026-10-14, including DB writes, persistence across restart, and IMDS isolation |
| `make verify-offline` | Not yet run; requires manual Mac disconnect |
| Boot/rebuild | Running EC2 verified after startup repairs; a clean rebuild with the corrected source remains pending |

## Latency

Run `make latency` only after connected verification passes and after verifying that the regional AWS API endpoint's route bypasses doxx on the Mac. Then set `DIRECT_BASELINE_CONFIRMED=1`. A full-tunnel Mac connection otherwise makes the supposed direct baseline another doxx path.

The suite runs 200 measured samples plus 10 discarded warmups for each sequential case, ten concurrent clients for 30 seconds, and one request after 90 seconds of application silence. WireGuard keepalives continue during idle. Write samples delete their own notes outside the measured write interval. Failed operations are counted, and partial results are saved even when a threshold fails.

```mermaid
sequenceDiagram
  participant M as Mac test client
  participant D as doxx network
  participant A as App
  participant R as RDS
  M->>D: TCP connection (K1)
  D->>A: GET / (K8, K10)
  A->>R: SQL query (db timing)
  R-->>A: Rows
  A-->>M: HTML + Server-Timing (app excludes db)
```

| Case | KPIs | Provisional target |
|---|---|---|
| TC-L1 TCP connection | K1, K3 | Report p50/p95/p99; p95 minus p50 <=20 ms |
| TC-L2 regional comparison | K2 | Median difference <=30 ms |
| TC-L3 warm health | K5, K7 | p95 <= TCP p95 +15 ms; app p95 <=5 ms |
| TC-L4 cold health | K6 | p95 <=2 × TCP p95 +20 ms |
| TC-L5 page read | K8 | DB p95 <=10 ms |
| TC-L6 note write | K9 | DB p95 <=20 ms |
| TC-L7 concurrent page reads | K10 | p95 <=2 × sequential page p95 |
| TC-L8 idle recovery | K11 | First request <= cold target |
| All operations | K4 | Zero failures |

Thresholds live in `tests/latency/thresholds.json`. The AWS API endpoint differs from the app host: K2 is an approximate regional comparison, not an isolated measurement of doxx overhead. TCP timing is a connect-time RTT proxy. Network residual includes client-side processing; component medians do not necessarily sum to the total median.

Review the real run before copying it to `results/baseline.json`. Record coarse client location and doxx server selection without account identifiers, addresses, cookies, credentials, or note contents. Calibrate provisional thresholds only once with written reasoning; preserve evidence of missed targets. `make report` generates four SVG graphs in light and dark variants and tables from the same baseline. No fabricated results or placeholder graphs are committed.

<!-- latency:start -->

No live baseline yet. Measurement and calibration belong to later plan steps.

<!-- latency:end -->

## API reference

<details>
<summary>Doxx API used by the scripts</summary>

All requests use form-encoded POSTs to `https://config.doxx.net/v1/`; authentication is in the body, never the URL or process arguments. Doxx responses containing private keys are kept in memory. The AWS CLI receives its request through a temporary 0600 JSON file inside a private directory under ignored `.local/`; the file is removed after success or failure. This avoids macOS subprocess `/dev/stdin` failures and keeps secrets out of command arguments. Errors show only sanitized message/error-code fields; complete response bodies and context are never printed. The scripts do not automatically retry mutations.

| Action | Parameters besides token | Use |
|---|---|---|
| `servers` | none, no token required | Discover locations |
| `list_tunnels` | none | Resolve selected tunnel and connection state |
| `create_tunnel` | `name`, `server`, `type=wireguard` | Allocate one tunnel seat |
| `wireguard` | `tunnel_token` | Fetch structured config |
| `firewall_rule_list` | `tunnel_token` | Read rules and Link All status |
| `firewall_rule_add` / `firewall_rule_delete` | `tunnel_token`, `protocol`, `src_ip`, `src_port`, `dst_ip`, `dst_port` | Manage only owned TCP 8080 rules |
| `delete_tunnel` | `tunnel_token` | Delete owned tunnel |

Use a net-admin token for mutations. References: [authentication](https://github.com/doxxcorp/config.doxx.net), [tunnels](https://github.com/doxxcorp/config.doxx.net/blob/main/docs/endpoints/tunnels.md), [firewall](https://github.com/doxxcorp/config.doxx.net/blob/main/docs/endpoints/firewall.md), [servers](https://github.com/doxxcorp/config.doxx.net/blob/main/docs/endpoints/servers.md). Documentation reviewed 2026-10-12; authenticated behavior has not been verified live.

| Remaining unknown | Validation needed |
|---|---|
| Actual assigned addresses and schema | Provisioning validates responses; do not infer from docs examples |
| AWS WireGuard compatibility and MTU | Live handshake, small and large response tests |
| Default VPC outbound routing | Confirm public subnet route and internet gateway before deployment |
| Mac DNS/routes | Verify tunnel connectivity and independent regional baseline path |

</details>

## Design decisions

| Choice | Alternative | Reason |
|---|---|---|
| Private RDS | PostgreSQL on EC2 / DynamoDB | Demonstrates a managed private database behind the app |
| Runtime secret fetch | Secrets embedded in Terraform/user data | Keeps key material and passwords out of state and source |
| Split tunnel | Full tunnel on EC2 | Preserves metadata, VPC DNS and AWS API access |
| Dedicated per-pair rule | Change Link All | Preserves existing account configuration |
| App source-IP and fixed Host/Origin checks | Rely only on doxx firewall | Restricts the peer and blocks browser DNS rebinding |
| Small explicit app archive | Git clone at boot | Reproducible source without GitHub credentials on EC2 |

<details>
<summary>Security and public repository boundary</summary>

- `.env`, `.local`, generated WireGuard configs, Terraform variables/state/plans and raw results are ignored. Keep state and the ownership journal private even though secret values are kept out of Terraform.
- AWS IAM allows the required WireGuard parameter and managed DB secret reads. The standard SSM managed policy is attached for administration; it has AWS-defined permissions beyond these two custom statements. This is a disposable single-instance demo, not a complete production least-privilege design.
- No inbound SSH, public HTTP rule, ALB, NAT gateway or public database. The instance's public IPv4 is for outbound connectivity.
- App code runs as `notes` with no capabilities and no IMDS access. Root startup code uses the instance role and managed master secret, then supplies only the scoped app credential. Service restarts rotate that credential; notes remain in the database.
- Public output should include source, lockfiles, example inputs, and sanitized measurement data only. Review any generated baseline before committing. Run `make security-check` before publication; it includes `results/baseline.json` and other generated results.
- Login and independent HTTPS are deferred. Do not use real personal information or sensitive notes in this stage. The DB is intentionally deleted without a final snapshot.

</details>

## Troubleshooting

| Symptom | Check |
|---|---|
| Tool cannot resolve external domains | Network/sandbox configuration; dependency download and provider validation may need host access |
| Tunnel name rejected | `make tunnels`; names must be unique and Mac/app tunnels distinct |
| AWS SSM write denied | The sanitized error identifies IAM/credential failures; check `ssm:PutParameter`, tagging permissions and any applicable KMS policy |
| Existing SSM parameter rejected | Use a unique parameter path; do not overwrite unrelated secrets |
| Link All rejected | Disable Link All in doxx before provisioning and leave it disabled while the instance runs |
| Matching firewall rule disabled | Enable or remove the parked rule in doxx, then rerun provisioning |
| Instance unavailable | Wait for RDS and cloud-init, then use `aws ssm start-session --target <instance-id>` |
| Tunnel down | Privately inspect `sudo wg show` and `journalctl -u wg-quick@doxx`; never publish config output |
| Service unavailable | `journalctl -u doxx-app`; check DB connectivity, CA and secret permissions |
| Connection times out while service is running | Reconnect the configured Mac tunnel. With the dxx CLI, use `dxx connect --name <configured-Mac-tunnel-name>`. On macOS, `route -n get <app-tunnel-ip>` should select the active tunnel interface; an `en0`/Wi-Fi route means the request is bypassing doxx |
| Startup cannot find iptables | The service PATH must include `/usr/sbin` and `/sbin`; the template includes them |
| Bootstrap fails with 42501 | RDS administrators cannot reset superuser/replication flags. Bootstrap checks the app role's default flags and changes only its login password |
| 403 from app | Use exactly `http://<tunnel-ip>:8080`; foreign or missing Host headers are rejected. Check Mac source IP and reload after a service restart to refresh CSRF. Form Origins must match the fixed app URL |
| Large responses stall | Revisit MTU and routes; 1380 is provisional |
| RDS version unavailable | Select a supported major version in `terraform.tfvars`, document the change |
| Boot package install fails | Check pinned AMI and AL2023 nodejs22 package availability |
| Cleanup interrupted | Retain local state/journal, inspect owned resources, then rerun cleanup |

## Costs and teardown

This configuration uses one `t3.micro`, one single-AZ `db.t4g.micro` with 20 GB gp3 storage, an 8 GB EC2 root disk, one public IPv4, a managed DB secret, a WireGuard SecureString, and one doxx seat. Actual charges also depend on runtime and transfer. The original plan's estimate is provisional and omits some line items; confirm current regional prices before applying. No spending cap is enforced by these scripts.

| Resource | Cost treatment |
|---|---|
| EC2 and public IPv4 | Billed while allocated/running under applicable AWS pricing |
| RDS compute and storage | Billed during the test; creation may take several minutes |
| Secrets Manager | Managed DB secret has applicable storage/API charges |
| Network and doxx seat | Depends on AWS transfer and the doxx subscription |

Run `make destroy` after tests. It displays a destruction plan and asks for `destroy`, then removes AWS resources before deleting owned doxx rules, tunnel, and SecureString. Database contents are permanently discarded. If provisioning succeeded but Terraform was never applied, use `bash scripts/doxx-teardown.sh` to clean up doxx/SSM only. Never run that standalone cleanup while an instance still depends on the tunnel.

Reproduction, actual cost recording, Git initialization/commit, HTTPS, login, and final cleanup are later plan steps; none is represented as already completed here.
