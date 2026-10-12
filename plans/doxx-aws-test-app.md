# Private test web app on AWS, reachable only over doxx.net

## Context

Goal: prove that a web app on AWS can live on the doxx.net network. The app runs on one
EC2 instance with **no inbound ports open**; the instance dials out to doxx.net over
WireGuard and the app is reachable only from devices on the same doxx account (this Mac,
which has an existing tunnel that must be connected for live tests). This shows the main reason to pair doxx.net with AWS:
private access with no ALB, bastion, AWS VPN or public attack surface.

Facts from the doxx docs (config.doxx.net + github.com/doxxcorp/config.doxx.net):

- API: form-encoded `POST https://config.doxx.net/v1/`, auth via `token` param; `net-admin` role is enough.
- `create_tunnel` (server, name) uses one seat; `tunnel_token` and keys come from `list_tunnels`; `wireguard=1` returns the config.
- Default config is full-tunnel (`AllowedIPs 0.0.0.0/0, ::/0`, DNS `10.10.10.10`), endpoint UDP 51820, keepalive 25. Tunnel IPs are `10.x` /31 plus `2602:f5c1:1::` IPv6.
- Tunnel-to-tunnel traffic needs "Link All" or a `firewall_rule_add` rule.
- `.doxx` names and doxx-CA certificates only work for clients using doxx DNS with the doxx root CA installed.
- Not documented: AWS, MTU, split tunnelling, exact firewall rule parameters. These are verified during the build (see step 0).

Local tooling already present: `aws` (us-east-1, credentials set), `terraform`, `wg`, `jq`, `node`, `docker`.

Confirmed preferences: use the default AWS credentials and `us-east-1`, minimize spending,
and destroy the deployment after tests and the reproducibility pass. Make the Mac tunnel
selection configurable. Build in three separate stages: private HTTP connectivity, HTTPS,
then login. HTTPS and login are part of the planned build, not optional follow-ups.

## Design

```
Mac (existing doxx tunnel) ──WireGuard──> doxx.net <──WireGuard── EC2 (AL2023, SG: no ingress)
                                                                    └─ node app bound to tunnel IP :8080
                                                                         └─ RDS Postgres (private, SG: 5432 from app SG only)
```

- **Database:** RDS PostgreSQL (`db.t4g.micro`, 20 GB, single-AZ, `publicly_accessible = false`). Its security group allows 5432 only from the app instance's security group. RDS cannot run WireGuard, so it is not on doxx itself; it sits behind the app, and the only way in from outside AWS is the app over the doxx mesh. The master password is managed by RDS in Secrets Manager (`manage_master_user_password = true`), so it stays out of Terraform state; the instance role reads that one secret. The app connects with TLS using the RDS CA bundle.
- **App:** Hono on Node (via `@hono/node-server`), serving a small notes page (list notes, add a note) stored in Postgres, plus the tunnel and caller IP info.
- **Secret handling:** the WireGuard config (private key) is rendered locally by a script and stored as an SSM Parameter Store `SecureString`. The instance fetches it at boot with its instance role. The key never enters Terraform state or user data.
- **Split tunnel on EC2:** `AllowedIPs` limited to the doxx ranges (start with `10.0.0.0/8, 2602:f5c1:1::/48`), and no `DNS =` line, so SSM, instance metadata and VPC DNS keep working. The default VPC is `172.31.0.0/16`, so `10.0.0.0/8` does not collide.
- **App binds to the tunnel address only**, so it is not even listening on the VPC interface.
- **Firewall:** add a per-pair rule (Mac tunnel IP -> EC2 tunnel IP, TCP 8080). Do not toggle "Link All": its response reports `rules_deleted`, so it could remove existing rules on the account. If Link All is already on, no rule is needed.
- **Doxx token:** scripts read `DOXX_TOKEN` from the environment. Nothing in `~/.config/doxx/` is read unless you point me at a file.
- **Staged transport:** the diagram and TCP 8080 rule above describe stage 1. Stage 2 moves the Node listener to HTTPS on the tunnel IP, port 8443, with a matching per-pair rule; remove the stage-1 HTTP listener and any HTTP rule created by this project. AWS security groups retain zero app ingress. Stage 3 adds login over HTTPS.

## Documentation and reproducibility (hard requirement)

Someone with a doxx.net account, an AWS account and this repo must be able to rebuild the whole thing from a clean checkout using only the README.

- **One entry point:** a `Makefile` with `make check` (tool and credential preflight), `make provision` (doxx tunnel + SSM parameter + firewall rule), `make deploy` (Terraform), `make verify`, `make latency`, `make report`, `make destroy`. The README documents the same steps as raw commands.
- **Separate security stages:** add `make https` / `make verify-https` and `make login` / `make verify-login`. Document prerequisites, configuration, raw commands, and acceptance checks for each stage in the README. Final verification and teardown cover all three stages.
- **Idempotent scripts:** `doxx-provision.sh` reuses an existing tunnel named `aws-test-app` instead of creating a second one, uses `put-parameter --overwrite`, and skips an existing firewall rule. Scripts use `set -euo pipefail` and never print the token or private key.
- **Pinned versions:** Terraform `required_version` and AWS provider version with `.terraform.lock.hcl` committed; Postgres engine version pinned with `auto_minor_version_upgrade = false`; Node major pinned by package name on AL2023; `package-lock.json` committed and installed with `npm ci`. The AMI defaults to the latest AL2023 via the public SSM parameter, with an `ami_id` variable to pin an exact image; the AMI actually used is a Terraform output.
- **No hidden inputs:** all configuration is in `infra/terraform.tfvars.example` and `.env.example` (`DOXX_TOKEN`, region, tunnel name, doxx server). Real `.env`, `terraform.tfvars`, state and rendered configs are gitignored.
- **Manual steps written down:** the things that cannot be scripted (doxx account signup, plan/trial, creating a `net-admin` token, having the Mac tunnel up) are listed as prerequisites with links.
- **Docs:** everything is in `README.md`; see the next section.
- **Version control:** `git init` on a `main` branch and commit the working result, so the documented state is the tested state.
- **Proof it reproduces:** after the first successful build, run `make destroy` and then the README steps again from scratch, and fix any step that needed knowledge not in the README.

## README as the single documentation (hard requirement)

All documentation lives in `README.md`. There is no `docs/` folder of prose; `docs/img/` holds only generated chart images that the README embeds. Everything must render on github.com without plugins.

**README structure** (with a table of contents; long reference parts sit in collapsible `<details>` blocks so the page stays scannable):

1. What this is and why use doxx.net with AWS
2. Architecture
3. Prerequisites
4. Build it (step by step, `make` targets and the raw commands behind them)
5. Verify
6. Latency: KPIs, method, results
7. doxx.net API reference used here
8. Design decisions and rejected alternatives
9. Troubleshooting
10. Costs and teardown

**Diagrams (Mermaid, rendered natively by GitHub):**

| Diagram | Type | Shows |
|---|---|---|
| Network path | `flowchart` | Mac -> doxx.net -> EC2 -> RDS, with security group boundaries and which ports are open |
| Boot and secret flow | `sequenceDiagram` | instance boot, SSM parameter fetch, WireGuard up, Secrets Manager read, app start |
| Request path | `sequenceDiagram` | one `GET /` from the Mac through the tunnel to Postgres and back, labelled with the latency KPI that measures each hop |
| Build order | `flowchart` | `make check` -> `provision` -> `deploy` -> `verify` -> `latency` -> `destroy` |

**Tables (GitHub Markdown):**

| Table | Content |
|---|---|
| Prerequisites | tool, tested version, how to check |
| Configuration | every variable in `.env` and `terraform.tfvars`, default, meaning |
| AWS resources | resource, type or size, purpose, hourly cost |
| Security group rules | group, direction, port, source or destination |
| doxx API calls | endpoint, parameters, role needed, what the script uses it for, date verified |
| Doc gaps found | what the official doxx docs leave out and what we measured instead |
| Latency KPIs | definition, target, measured p50/p95/p99, pass or fail |
| Test cases | ID, KPIs covered, sample size, command |
| Design decisions | choice, alternative rejected, reason |
| Troubleshooting | symptom, likely cause, fix |

**Latency graphs (generated SVG, committed to `docs/img/`):** Mermaid is used for diagrams only; data charts are SVG files so they render identically everywhere and need no chart support from GitHub.

| Graph | Form | Answers |
|---|---|---|
| `latency-percentiles` | grouped bars (p50, p95, p99) per test case, with the target drawn as a line | does each KPI meet its target? |
| `latency-breakdown` | stacked bar per route: network, app, database | where does the time go? |
| `rtt-distribution` | histogram of tunnel RTT next to the direct-to-region baseline | what does the doxx overlay add? |
| `load-timeline` | line of p95 per second during the 30 s concurrency test | is latency stable under load? |

- `scripts/latency-report.mjs` (plain Node, no dependencies) reads `results/baseline.json`, writes the SVGs in a light and a dark variant, and rewrites the latency results table in the README between `<!-- latency:start -->` and `<!-- latency:end -->` markers. `make report` runs it.
- The README embeds each graph with a `<picture>` element using `prefers-color-scheme`, so it is readable in GitHub's light and dark themes. Every graph has alt text and sits directly above the table holding the same numbers.
- The numbers in the README are therefore generated from a committed result file, never typed by hand. Rerunning `make latency && make report` updates graphs and table together.

## Latency KPIs and test cases

Measured from the Mac over the doxx tunnel with `make latency` (Node's built-in test runner, `node --test`, no extra tooling). Each run writes `results/latency-<timestamp>.json` and fails if a KPI misses its threshold.

**App instrumentation:** every response carries a `Server-Timing` header (`app;dur=…, db;dur=…`), and `GET /healthz/db` runs `SELECT 1` and reports its duration. This separates network time from server and database time.

| KPI | Definition | Provisional target |
|---|---|---|
| K1 Tunnel RTT | TCP connect time Mac -> EC2 tunnel IP:8080 (ICMP too, if doxx passes it), p50/p95 | report; baseline for the others |
| K2 Overlay overhead | K1 p50 minus direct TCP connect p50 from the Mac to an AWS endpoint in the same region | <= 30 ms |
| K3 Jitter | K1 p95 minus p50 | <= 20 ms |
| K4 Failures | failed connects or requests across the run | 0 of all requests |
| K5 Warm request | `GET /healthz` on a kept-alive connection, p95 | <= K1 p95 + 15 ms |
| K6 Cold request | `GET /healthz` with a new connection each time, p95 | <= 2 x K1 p95 + 20 ms |
| K7 App time | server `app` duration for `/healthz`, p95 | <= 5 ms |
| K8 DB read | server `db` duration for `GET /`, p95 | <= 10 ms |
| K9 DB write | server `db` duration for `POST /notes`, p95 | <= 20 ms |
| K10 Under load | `GET /` p95 at 10 concurrent clients for 30 s | <= 2 x single-client p95, 0 errors |
| K11 After idle | first request after 90 s of silence | <= K6 target (keepalive holds the path open) |

Targets are provisional because the Mac's location and doxx server pairing are not yet measured. They live in `tests/latency/thresholds.json`; after the first run they are calibrated once, and the measured baseline (`results/baseline.json`) plus the reasoning go into the README's latency section.

**Test cases** (`tests/latency/*.test.mjs`): TC-L1 tunnel RTT and failures (K1, K3, K4); TC-L2 overhead against the direct-to-region baseline (K2); TC-L3 warm requests (K5, K7); TC-L4 cold requests (K6); TC-L5 DB read (K8); TC-L6 DB write (K9, cleans up its notes); TC-L7 concurrency (K10); TC-L8 idle recovery (K11). Sample sizes: 200 requests per sequential case, with the first 10 discarded as warm-up.

The README's latency section documents each KPI, the method, how to rerun, and the recorded baseline (date, Mac location, doxx servers on both ends, AWS region), so later runs are comparable.

## Files to create (repo is empty)

- `tests/latency/*.test.mjs`, `tests/latency/lib.mjs` (timing and percentile helpers), `tests/latency/thresholds.json`, `scripts/latency-report.mjs`, `docs/img/*.svg` (generated); `results/` is gitignored except `results/baseline.json`.

- `Makefile`, `.env.example`, `infra/terraform.tfvars.example`, `scripts/verify.sh` (automates the checks in Verification and exits non-zero on failure).

- `scripts/doxx-provision.sh`: `servers=1` -> pick a server near us-east-1; `create_tunnel` name `aws-test-app`; `list_tunnels` -> find `tunnel_token`; `wireguard=1` -> render `doxx.conf` with split-tunnel `AllowedIPs`; `aws ssm put-parameter --type SecureString --name /doxx-test-app/wg-conf`; print the EC2 tunnel IP; add the firewall rule.
- `scripts/doxx-teardown.sh`: delete firewall rule, `delete_tunnel`, delete the SSM parameter.
- `infra/main.tf`, `variables.tf`, `outputs.tf`: default VPC public subnet, `t3.micro` Amazon Linux 2023, security group with egress only, IAM role with `AmazonSSMManagedInstanceCore` plus `ssm:GetParameter` on the one parameter, IMDSv2 required.
- `infra/user_data.sh.tftpl`: `dnf install -y wireguard-tools nodejs`; fetch the parameter to `/etc/wireguard/doxx.conf` (mode 600); `systemctl enable --now wg-quick@doxx`; write `app/server.js` and a systemd unit `After=wg-quick@doxx.service`.
- `infra/rds.tf`: DB subnet group (default VPC subnets), DB security group, `aws_db_instance` (Postgres, `skip_final_snapshot = true`, no deletion protection, since this is a throwaway test), IAM policy for `secretsmanager:GetSecretValue` on the RDS-managed secret.
- `app/server.js` + `app/package.json` + `package-lock.json` (dependencies: `hono`, `@hono/node-server`, `pg`; plain ESM JavaScript, no build step): Hono app with routes `GET /` (page), `POST /notes`, `GET /healthz`, showing hostname, its tunnel IP, the caller's source IP (which should be the Mac's doxx IP), and the notes list/form. Creates the `notes` table on start. User data runs `npm ci`, downloads the RDS CA bundle and passes the DB host and secret ARN via an environment file.
- `README.md` (the only documentation, structure above), `.gitignore` (Terraform state, any rendered `.conf`).

## Steps

0. **Verify the unknowns (read-only):** read `docs/endpoints/firewall.md` and `servers.md` for exact parameters; call `list_tunnels` and `firewall_link_all_status` to get the Mac's tunnel IP, the real address ranges and current firewall state. Adjust `AllowedIPs` and the rule to match.
1. Write the scripts, Terraform and app.
2. Run `doxx-provision.sh` (creates one tunnel, uses one seat, and writes one SSM parameter).
3. `terraform init && terraform apply` (shown as a plan first).
4. Verify (below) with `make verify`.
5. Run `make latency`, calibrate thresholds once, save the run as `results/baseline.json`, then `make report` to generate the graphs and the README results table.
6. Write the README from what was actually run (all sections, diagrams and tables above), `git init`, commit.
7. Reproducibility pass: `make destroy`, rebuild from the README alone, fix gaps, commit.
8. **Stage 2 — add HTTPS:** follow the dedicated HTTPS step below and verify it independently before adding login.
9. **Stage 3 — add login:** follow the dedicated login step below and verify authenticated access independently.
10. Repeat the README reproduction check for the complete HTTPS + login deployment, record sanitized results, and destroy all project-owned resources after testing. Reuse the small instance and database for both added stages; no load balancer or paid identity service is required.

### Stage 2 — HTTPS

1. Choose a configurable, available `.doxx` name (for example `notes.doxx`); do not overwrite an existing domain or DNS record. Register it and add an A record pointing to the instance's tunnel IP. Track which resources the project created so teardown preserves pre-existing resources.
2. Generate the TLS private key locally, submit only a CSR to `sign_certificate`, and retrieve the signed certificate and current doxx root CA. Verify the current API parameters and certificate chain against the official reference during implementation.
3. Store the private key outside Git and Terraform in an SSM `SecureString`; give the instance permission to read only the required parameters. Install runtime key files with restrictive permissions. Never include private keys in user data, logs, command-line arguments, or public test results.
4. Serve HTTPS directly from Node on the tunnel IP at port 8443. Add the Mac-to-instance TCP 8443 rule, then remove the HTTP listener and project-owned TCP 8080 rule after HTTPS verification succeeds. Preserve account-wide Link All settings.
5. Document connecting the selected Mac tunnel, configuring doxx DNS, and explicitly installing/trusting the current doxx root CA. Connecting a tunnel alone is not proof that browser trust is configured. Document certificate renewal and service reload.
6. Verify `https://<app-name>.doxx:8443` in the browser and with certificate validation enabled: correct hostname, valid chain, and working notes persistence. Confirm public-IP access and old HTTP access fail. Never use disabled certificate validation as a passing test.
7. Extend `.env.example`, scripts, IAM permissions, boot setup, and README for the domain, HTTPS port, certificate parameter names, and CA path. Add `scripts/https-provision.sh` and HTTPS verification checks. Keep generated credentials and local trust configuration out of the public repository.
8. Record a separate HTTPS benchmark baseline. Keep TCP connection timing separate from TLS handshake timing; stage-1 cold-request thresholds do not account for TLS and must not silently be reused or relaxed. Include transport and TLS settings in result metadata.

### Stage 3 — Login

1. Add one configurable administrator account for this demo, with no public signup. Bootstrap its password through a hidden local prompt; store only a salted password hash using a suitable password KDF (for example Node's scrypt). Keep the hash in an SSM `SecureString`, outside Terraform state, user data, Git, and logs. Document password reset and session invalidation.
2. Add a login page, login submission, and POST logout. Require authentication for notes, writes, database diagnostics, and host/caller details. Only the login page and a minimal, non-sensitive liveness endpoint may be unauthenticated. Refuse to enable login without HTTPS configured.
3. Use cryptographically random, server-side sessions stored in PostgreSQL, storing hashes of session tokens. Rotate the session on successful login, enforce expiration, and invalidate it on logout and password reset. Use a host-only `Secure`, `HttpOnly`, `SameSite` cookie scoped to `/`.
4. Add CSRF protection for state-changing requests, login attempt throttling, generic failure messages, input limits, escaped note output, and parameterized database queries. Do not trust forwarded client-IP headers from callers.
5. Add `scripts/login-provision.sh`, authentication/session handling, database schema changes, and tests. Document username configuration and secret parameter names in example files, without a working default password or session secret. Fetch runtime credentials with narrowly scoped instance permissions.
6. Verify anonymous users cannot read notes or submit writes; wrong passwords fail; valid login works; cookies have the required flags; expired and logged-out sessions fail; CSRF attempts fail; and repeated failed logins are throttled. Confirm notes still survive application restarts.
7. Update verification and latency tools to authenticate normally and retain cookies only in private local files or memory. Never add an authentication bypass for benchmarks. Record a separate HTTPS + login baseline, keeping login time separate from authenticated request timings and excluding passwords, cookies, tokens, and note contents from committed results.
8. Reproduce both added stages from the README, scan staged files for secrets and private deployment identifiers before committing, then tear down. Remove project-owned DNS records, certificates/private-key parameters, login parameters, sessions, and other resources as supported by the APIs; document any domain registration or certificate revocation limits and manual cleanup. Do not remove a shared Mac trust anchor automatically.

## Verification

- `curl http://<ec2-tunnel-ip>:8080` from the Mac returns the page and shows the Mac's doxx IP as the caller.
- `curl --max-time 5 http://<ec2-public-ip>:8080` times out; `aws ec2 describe-security-groups` shows zero ingress rules.
- With the Mac's doxx tunnel down, the first curl fails.
- Add a note with `curl -d 'text=hello' http://<ec2-tunnel-ip>:8080/notes`, reload, and it is listed; it survives `systemctl restart` of the app (proves it is in Postgres).
- `aws rds describe-db-instances` shows `PubliclyAccessible: false`, and the DB security group has a single ingress rule from the app security group.
- `list_tunnels` shows `aws-test-app` with `is_connected: true`.
- If the tunnel does not come up: `aws ssm start-session` to the instance, then `sudo wg show` and `journalctl -u wg-quick@doxx`. If large responses stall, set `MTU = 1380` in the config.

## Cost and cleanup

About $0.03/hour in total (`t3.micro` about $0.01, `db.t4g.micro` plus storage about $0.02, Secrets Manager $0.40/month prorated) plus one doxx seat. RDS takes roughly 5 to 10 minutes to create. Cleanup: `terraform destroy` (deletes the database and its data, no final snapshot), then `doxx-teardown.sh`.

## Not included

- Reaching Postgres directly from the Mac over doxx (possible later by relaying 5432 through the instance's tunnel IP).
- Alternatives considered for the database: Postgres in Docker on the instance (cheaper, but not a managed AWS database) and DynamoDB (no network path to protect, so it shows less).
