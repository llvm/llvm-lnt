This directory contains configuration files to deploy lnt.llvm.org.

The https://lnt.llvm.org instance gets re-deployed automatically whenever changes
are made to the configuration files under `deployment/` on the `main` branch via
a Github Action. Manually deploying the instance is also possible by directly using
Terraform:

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
