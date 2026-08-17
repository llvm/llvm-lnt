This directory contains configuration files to deploy lnt.llvm.org.

In order to perform a deployment, the following requirements must be satisfied:
1. The Github repository should have secrets named `AWS_ACCESS_KEY_ID` and
   `AWS_SECRET_ACCESS_KEY` to allow Github action to connect to an AWS account.
2. The active AWS account must contain a S3 bucket named `lnt.llvm.org-terraform-state-prod`
   which will be used to store the Terraform state. Versioning should be enabled on
   that bucket.
3. The active AWS account should have `lnt.llvm.org-secrets` in the AWS secret manager
   with entries `lnt-db-password` and `lnt-auth-token`. Those will be used for the
   database password used by LNT and the authentication token for destructive actions,
   respectively.
4. That same secret must contain `lnt-origin-cert` and `lnt-origin-key`, holding the TLS
   certificate and private key served by Nginx. See "TLS and DNS setup" below for how to
   obtain them.

Once the above is satisfied, an instance can be re-deployed automatically by running
the `deploy-lnt.llvm.org.yaml` Github Action. Manually deploying the instance is also
possible by directly using Terraform:

```bash
aws configure # provide appropriate access keys
terraform -chdir=deployment init
terraform -chdir=deployment plan # to see what will be done
terraform -chdir=deployment apply
```

At a high level, lnt.llvm.org is running in a Docker container on an EC2 instance. When
the EC2 instance is created, `cloud-init` will run a script that uses `systemctl` to register
a service that runs the Docker Compose service on every boot. The `cloud-init` step only runs
once per instance creation. This step can be inspected with:

```bash
less /var/log/cloud-init-output.log
less /var/log/cloud-init.log # usually less interesting
```

Subsequently, `systemctl` will launch the Docker Compose service as instructed. This
step runs once per boot and can be inspected with:

```bash
systemctl status lnt.service
journalctl -u lnt.service
```

The Docker Compose service itself should now be running, and it can be inspected with:

```bash
docker ps
docker compose -f docker/compose.yaml logs webserver
docker compose -f docker/compose.yaml logs db  # usually less interesting
```

The database is stored in an independent EBS storage that gets attached and detached
to/from the EC2 instance when it is created/destroyed, but the EBS storage has its own
independent life cycle (because we want the data to outlive any specific EC2 instance).

The state used by Terraform to track the current status of the instance, EBS storage, etc
is located in a S3 bucket defined in the Terraform file. It is updated automatically when
changes are performed via the `terraform` command-line. Terraform is able to access that
data via the AWS credentials that are set up by `aws configure`.

## TLS and DNS setup

Browser traffic does not reach the instance directly. The domain is proxied through
Cloudflare, which terminates the publicly-trusted TLS connection and then makes its own
TLS connection to Nginx on the instance:

```
visitor --https(Cloudflare cert)--> Cloudflare --https(Origin CA cert)--> nginx --> gunicorn
```

The certificate installed on the instance is a *Cloudflare Origin CA* certificate. It is
trusted by Cloudflare but deliberately not by browsers, which is fine because browsers only
ever talk to Cloudflare. Two properties make this a good fit here:

- It is valid for 15 years, so there is no renewal machinery to maintain. This matters
  because `user_data_replace_on_change` means the instance is destroyed and recreated on
  every configuration change, which would otherwise repeatedly discard ACME state and run
  into Let's Encrypt's rate limits.
- It can be delivered through the same Secrets Manager and `cloud-init` path already used
  for the database password, so no new mechanism is needed.

To set this up for a domain managed by Cloudflare:

1. Under DNS, add an `A` record for the desired subdomain pointing at the instance's
   elastic IP, with the proxy enabled (the orange cloud). DNS must be in place first;
   everything else depends on the name resolving.
2. Under SSL/TLS > Origin Server, choose "Create Certificate" and generate a certificate
   for the subdomain. Save both the certificate and the private key.
3. Store them in the `lnt.llvm.org-secrets` secret under the `lnt-origin-cert` and
   `lnt-origin-key` keys, then `terraform apply`. Be aware that this recreates the EC2
   instance; the database lives on the EBS volume and is unaffected.
4. Once the instance is serving HTTPS, set the SSL/TLS encryption mode to "Full (strict)"
   so that Cloudflare validates the origin certificate, and enable "Always Use HTTPS" so
   visitors arriving over HTTP are upgraded at the edge.

A few things worth knowing about this arrangement:

- Nginx keeps serving plain HTTP on port 80 rather than redirecting to HTTPS. Since the
  domain resolves to Cloudflare, port 80 is only reachable by connecting to the instance's
  IP address directly, where it serves as a debugging escape hatch and as a way to submit
  payloads larger than Cloudflare's request body limit (100 MB on the free plan, which is
  roughly what `client_max_body_size` already allows). Redirecting there would only produce
  a certificate warning, since the Origin CA certificate is not browser-trusted and is not
  issued for a bare IP address.
- The private key ends up in the instance's user-data and therefore in the Terraform state
  in S3. This is the same exposure the database password and auth token already have, but a
  private key is a higher-value target. Restricting the security group to Cloudflare's
  published IP ranges, so the origin cannot be reached directly at all, is a reasonable
  follow-up hardening step.
- `deployment/nginx.tls.conf` is used only in production. The configuration under
  `docker/nginx.conf` stays HTTP-only and is what local development and the Docker smoke
  test use.
