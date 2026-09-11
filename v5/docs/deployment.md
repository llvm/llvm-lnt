# v5 Deployment

The production stack is a single EC2 host running Docker Compose (the app + Nginx), talking to a
Postgres instance on RDS. DNS and TLS termination are handled by Cloudflare; the Nginx origin holds a
Cloudflare Origin CA certificate so traffic between Cloudflare and the origin is encrypted too.

Everything is provisioned with Terraform, split into two modules under `v5/deployment/`:

- `bootstrap`: creates the S3 bucket that `main` uses as its remote state backend, the OIDC provider
  and IAM role the `v5 Deploy` GitHub Actions workflow uses to authenticate to AWS, and the instance
  role the app server runs under. This is used once on a new AWS deployment. Its own state is local
  and not committed.
- `main`: the actual stack configuring networking, RDS, the EC2 instance, and the Cloudflare DNS
  record + Origin CA certificate.

## One-time bootstrap

```sh
export AWS_PROFILE=your-aws-profile
terraform -chdir=v5/deployment/bootstrap init
terraform -chdir=v5/deployment/bootstrap apply
```

This creates the `lnt-v5-terraform-state` S3 bucket to hold the Terraform state, and an IAM role for
the deployment pipeline. One thing is worth knowing before the first apply: S3 bucket names are
globally unique. If `lnt-v5-terraform-state` is taken, set `-var="state_bucket_name=..."` and put the
same value in `v5/deployment/main/backend.tf` (which cannot read variables).

The module also creates the app server's instance role since that makes it easier to harden against
priviledge escalation than letting the deployment pipeline edit its own IAM settings.

Finally, the module creates the GitHub Actions OIDC provider. An AWS account can hold only one OIDC
provider per URL, so if the account already trusts GitHub Actions for another project, apply with
`-var="manage_github_oidc_provider=false"` to reuse the existing one. By default the OIDC role is
assumable only from the `v5-production` environment of `llvm/llvm-lnt`. The `github_repo` and
`github_environment` variables can be overridden if needed (e.g. iterating from a fork).

After applying, configure the following once in the GitHub repository, under a `v5-production`
environment:

- Secret `V5_CLOUDFLARE_API_TOKEN`: an API token for the account the domain is configured under. It
  needs `Zone:DNS:Edit` and `Zone:SSL and Certificates:Edit`, scoped to the domain's zone.
- Variables `V5_DOMAIN` and `V5_CLOUDFLARE_ZONE_ID`: the domain name in use and the Cloudflare zone ID
  of that domain. Not sensitive.
- Variable `V5_AWS_DEPLOY_ROLE_ARN`: output by the bootstrap module as `github_actions_deploy_role_arn`.
  This is what lets the deploy pipeline act in the AWS account, via the OIDC trust chain established during
  bootstrap. Not sensitive.

## Building and pushing the app image

The `v5 Test` workflow builds the image on all PRs and branch pushes that touch `v5/`, after running
the test suites. On pushes to `main` (exclusively), the image is pushed to `ghcr.io/llvm/llvm-lnt-v5`
and tagged with the commit's short SHA as well as `latest`.

## Deploying the web app

Deploying is done manually by triggering the `v5-deploy.yml` GitHub workflow. Select the image tag to
use and launch the workflow, which runs `terraform apply` in `v5/deployment/main` with that tag, then
waits for `/healthz` to report healthy.

Changing the image tag rewrites the instance's `user_data`, and `user_data_replace_on_change` means
the EC2 instance is recreated to pick it up. That replacement *is* the deployment mechanism; expect a
short outage on each deploy. Because all persistent state lives in RDS, nothing is lost.

Alternatively, deployment can be triggered locally:

```sh
export AWS_PROFILE=your-aws-profile
terraform -chdir=v5/deployment/main init
terraform -chdir=v5/deployment/main apply -var="app_image_tag=..."         \
                                          -var="cloudflare_api_token=..."  \
                                          -var="cloudflare_zone_id=..."    \
                                          -var="domain=lnt.example.com"
```

## Sizing

When deploying a server, you should set `WEB_CONCURRENCY` to let uvunicorn use more than the
single worker it uses by default. However, be aware that each worker holds its own database
connection pool, so the instance's ceiling against RDS is `WEB_CONCURRENCY x (POOL_SIZE + MAX_OVERFLOW)`,
which has to stay well inside the `max_connections` of the database instance. Moving to a larger
instance means revisiting both numbers together.

## Operating the instance

There is no inbound SSH. The instance's IAM role carries `AmazonSSMManagedInstanceCore`, so shell
access goes through Session Manager:

```sh
aws ssm start-session --target <instance-id> --region us-west-2
```

From there, `cd /opt/app && docker compose ps` and `docker compose logs app` are the usual starting
points. `/var/log/cloud-init-output.log` has the boot-time provisioning output.
