# v5 Deployment

The production stack is a single EC2 host running Docker Compose (the app + Nginx), talking to a
Postgres instance on RDS. DNS and TLS termination are handled by Cloudflare; the Nginx origin holds a
Cloudflare Origin CA certificate so traffic between Cloudflare and the origin is encrypted too.

Everything is provisioned with Terraform, split into two modules under `v5/deployment/`:

- `bootstrap`: creates the S3 bucket that `main` uses as its remote state backend, the OIDC provider
  and IAM role the `v5 Deploy` GitHub Actions workflow uses to authenticate to AWS, and the instance
  roles the app servers run under. This is used once on a new AWS deployment. Its own state is kept
  in the same S3 bucket, next to `main`'s.
- `main`: the actual stack configuring networking, RDS, the EC2 instance, and the Cloudflare DNS
  record + Origin CA certificate.

The stack is deployed to two environments, `production` and `test`. Each environment is a complete,
independent copy of the `main` stack with its own domain, database and instance.

## One-time bootstrap

The `bootstrap` module keeps its state in the S3 bucket that it creates, so the very first apply on a
new AWS account has to start from local state, which is then moved into the bucket:

```sh
export AWS_PROFILE=your-aws-profile

# The state bucket doesn't exist yet, so temporarily override the backend to use local state.
cat > v5/deployment/bootstrap/backend_override.tf <<'EOF'
terraform {
  backend "local" {}
}
EOF
terraform -chdir=v5/deployment/bootstrap init
terraform -chdir=v5/deployment/bootstrap apply

# Now that the bucket exists, move the state into it.
rm v5/deployment/bootstrap/backend_override.tf
terraform -chdir=v5/deployment/bootstrap init -migrate-state
```

After migrating the bootstrap state, the bootstrap state is stored in S3 alongside the `main` state
that will be created on the first deployment. From then on, `bootstrap` is used like any other module
(`init`, then `apply`) from any machine with credentials for the account.

This creates the `lnt-v5-terraform-state` S3 bucket to hold the Terraform state, and an IAM role for
the deployment pipeline. One thing is worth knowing before the first apply: S3 bucket names are
globally unique. If `lnt-v5-terraform-state` is taken, set `-var="state_bucket_name=..."` and put the
same value in the `backend.tf` of both `v5/deployment/bootstrap` and `v5/deployment/main` (which
cannot read variables).

The module also creates an instance role for the app server of each environment since that makes it
easier to harden against privilege escalation than letting the deployment pipeline edit its own IAM
settings.

Finally, the module creates the GitHub Actions OIDC provider if requested. Since an AWS account can
hold only one OIDC provider per URL, this defaults to reusing an existing provider. If the account
does not already trust GitHub Actions, apply with `-var="manage_github_oidc_provider=true"` to create
the provider. By default the OIDC role is assumable only from the `production` and `test`
environments of `llvm/llvm-lnt`. The `github_repo` variable can be overridden if needed (e.g.
iterating from a fork).

After applying, configure the following once in the GitHub repository, under each environment:

- Secret `V5_CLOUDFLARE_API_TOKEN`: an API token for the account the domain is configured under. It
  needs `Zone:DNS:Edit` and `Zone:SSL and Certificates:Edit`, scoped to the domain's zone.
- Variables `V5_DOMAIN` and `V5_CLOUDFLARE_ZONE_ID`: the domain name in use and the Cloudflare zone ID
  of that domain. Not sensitive.
- Variable `V5_AWS_DEPLOY_ROLE_ARN`: output by the bootstrap module as `github_actions_deploy_role_arn`.
  This is what lets the deploy pipeline act in the AWS account, via the OIDC trust chain established during
  bootstrap. Not sensitive. The role is shared by all environments.
- Deployment branches: restrict the environment to `main` to control who can run deployments.

## Building and pushing the app image

The `v5 Test` workflow builds the image on all PRs and branch pushes that touch `v5/`, after running
the test suites. On pushes to `main` (exclusively), the image is pushed to `ghcr.io/llvm/llvm-lnt-v5`
and tagged with the commit's short SHA as well as `latest`.

## Deploying the web app

Deploying is done manually by triggering the `v5-deploy.yml` GitHub workflow. Select the environment
to deploy to and the image tag to use, and launch the workflow. It runs `terraform apply` in
`v5/deployment/main` with that tag and the appropriate environment, and then waits for `/healthz` to
report healthy.

Changing the image tag rewrites the instance's `user_data`, and `user_data_replace_on_change` means
the EC2 instance is recreated to pick it up. That replacement *is* the deployment mechanism; expect a
short outage on each deploy. Because all persistent state lives in RDS, nothing is lost.

Alternatively, deployment can be triggered locally:

```sh
export AWS_PROFILE=your-aws-profile
terraform -chdir=v5/deployment/main init
terraform -chdir=v5/deployment/main workspace select -or-create test
terraform -chdir=v5/deployment/main apply -var="app_image_tag=..."         \
                                          -var="cloudflare_api_token=..."  \
                                          -var="cloudflare_zone_id=..."    \
                                          -var="domain=lnt.example.com"
```

## Tearing down an environment

The `v5-teardown.yml` GitHub workflow destroys everything Terraform manages in an environment,
including its database and DNS record, and then deletes the environment's Terraform workspace. In
practice this is for cleaning up the `test` environment after a round of testing. The destroy plan
is published to the run summary before being applied, so each run leaves a record of what it
destroyed. Deploying to the environment again recreates it from scratch.

The workflow deliberately doesn't offer the `production` environment. Its database has deletion
protection, and deleting it takes a final snapshot (`lnt-v5-production-final`) and keeps the
automated backups. Tearing down production is thus a manual procedure, meant to be done only in
exceptional circumstances and by someone who knows exactly what they are doing:

```sh
export AWS_PROFILE=your-aws-profile
aws rds modify-db-instance --db-instance-identifier lnt-v5-production --no-deletion-protection \
                           --apply-immediately --region us-west-2
terraform -chdir=v5/deployment/main workspace select production
terraform -chdir=v5/deployment/main destroy -var="app_image_tag=unused-by-destroy" \
                                            -var="cloudflare_api_token=..."        \
                                            -var="cloudflare_zone_id=..."          \
                                            -var="domain=lnt.example.com"
```

Since snapshot names are unique, the final snapshot of a previous teardown has to be deleted or
renamed before production can be torn down again.

## Database schema

The app applies any outstanding schema changes to its database when it starts, before it begins
serving: first to the instance-wide tables, then to the built-in tables of every existing test suite.
A suite's own metrics and fields are a different matter -- their columns are created and altered
through the test-suite API as the suite is defined, not by a migration.

Migrations do not keep the previous version of the app working, which is fine because a deployment
replaces the instance rather than running both side by side. Starting an older image against a
database that a newer one has migrated fails rather than serving.

To inspect or apply the schema by hand, run the same command the server runs at startup:

```sh
sudo docker compose exec app lnt-v5 server migrate
```

It reports whether it applied anything, and is safe to run repeatedly.

## Creating the first API key

Write endpoints need a bearer token, and the key-management endpoints themselves require `admin` scope.
A freshly deployed instance has no keys at all, so the first one has to be created from the host. This
is also how to recover from revoking the last `admin` key.

```sh
aws ssm start-session --target <instance-id> --region <region>
cd /opt/app
sudo docker compose exec app lnt-v5 server create-key --name bootstrap --scope admin
```

The command has to run inside the `app` container, which is where `DATABASE_URL` is set. It prints
the raw token on stdout. That token is shown once and is not stored anywhere in recoverable form.
Save it before closing the session; if you lose it, create another key and revoke the old one. From
then on, keys are managed over the API or from the Admin page in the web UI.

## Sizing

When deploying a server, you should set `WEB_CONCURRENCY` to run more than the single worker
the server uses by default. However, be aware that each worker holds its own database
connection pool, so the instance's ceiling against RDS is `WEB_CONCURRENCY x (POOL_SIZE + MAX_OVERFLOW)`,
which has to stay well inside the `max_connections` of the database instance. Moving to a larger
instance means revisiting both numbers together.

Memory scales with concurrency too. Parsing a profile at the largest size the server accepts peaks at
about 200 MiB, and each submission in flight can reach that at the same time. Reading such a profile
back whole, as a document, peaks at about 60 MiB per request, and needs no API key. Scale the
instance in accordance with the expected usage.

## Operating the instance

There is no inbound SSH. The instance's IAM role carries `AmazonSSMManagedInstanceCore`, so shell
access goes through Session Manager.

```sh
aws ssm start-session --target <instance-id> --region us-west-2
```

From there, `cd /opt/app && docker compose ps` and `docker compose logs app` are the usual starting
points. `/var/log/cloud-init-output.log` has the boot-time provisioning output.
