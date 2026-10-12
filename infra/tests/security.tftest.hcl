mock_provider "aws" {
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_vpc" {
    defaults = {
      id         = "vpc-0123456789abcdef0"
      cidr_block = "172.31.0.0/16"
    }
  }
  mock_data "aws_subnets" {
    defaults = { ids = ["subnet-0123456789abcdef0", "subnet-0123456789abcdef1"] }
  }
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0123456789abcdef0" }
  }
}
run "private_network_plan" {
  command = plan
  variables {
    tunnel_ip = "10.1.0.2"
    client_ip = "10.1.0.4"
  }
  assert {
    condition     = length(aws_security_group.app.ingress) == 0
    error_message = "App security group must never expose inbound ports."
  }
  assert {
    condition     = !aws_db_instance.notes.publicly_accessible && aws_db_instance.notes.storage_encrypted && aws_db_instance.notes.manage_master_user_password
    error_message = "RDS must be private, encrypted, and manage its password outside state."
  }
  assert {
    condition     = length(aws_security_group.db.ingress) == 1 && one(aws_security_group.db.ingress).from_port == 5432 && length(coalesce(one(aws_security_group.db.ingress).cidr_blocks, [])) == 0
    error_message = "DB ingress must use a single security-group rule, not a CIDR."
  }
  assert {
    condition     = aws_instance.app.metadata_options[0].http_tokens == "required"
    error_message = "IMDSv2 is required."
  }
}
