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

Once the above is satisfied, an instance can be re-deployed automatically by running
the `deploy-lnt.llvm.org.yaml` Github Action. Manually deploying the instance is also
possible by directly using Terraform:

```bash
aws configure # provide appropriate access keys
terraform -chdir=deployment init
terraform -chdir=deployment plan # to see what will be done
terraform -chdir=deployment apply
```

At a high level, lnt.llvm.org is running in a Docker container on an EC2 instance.
The database is stored in an independent EBS storage that gets attached and detached
to/from the EC2 instance when it is created/destroyed, but the EBS storage has its own
independent life cycle (because we want the data to outlive any specific EC2 instance).

The state used by Terraform to track the current status of the instance, EBS storage, etc
is located in a S3 bucket defined in the Terraform file. It is updated automatically when
changes are performed via the `terraform` command-line. Terraform is able to access that
data via the AWS credentials that are set up by `aws configure`.
