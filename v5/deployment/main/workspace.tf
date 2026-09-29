# Each Terraform workspace is one deployment of the stack, named after the environment it is (e.g.
# `production` or `test`). Every named resource carries the workspace name so that several deployments
# can live side by side in the same account.
locals {
  stack_name = "${var.resource_prefix}-${terraform.workspace}"
}

# The instance profile that deployment/bootstrap creates for each environment. Looking it up here
# means that a workspace which is not one of those environments fails at plan time, before anything
# is created. The `default` workspace gets a clearer error than a missing profile since forgetting
# to select a workspace is likely.
data "aws_iam_instance_profile" "app" {
  name = "${local.stack_name}-app"

  lifecycle {
    precondition {
      condition     = terraform.workspace != "default"
      error_message = "Select the workspace of the environment to deploy (e.g. `terraform workspace select test`)."
    }
  }
}
