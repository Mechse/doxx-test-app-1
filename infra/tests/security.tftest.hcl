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
  override_resource {
    target          = aws_security_group.db
    override_during = plan
    values          = { id = "sg-0123456789abcdef0" }
  }
  variables {
    tunnel_ip            = "10.1.0.2"
    client_ip            = "10.1.0.4"
    tunnel_endpoint_ips  = ["198.51.100.8"]
    tunnel_endpoint_port = 51820
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
    condition     = aws_security_group_rule.db_from_app.from_port == 5432 && aws_security_group_rule.db_from_app.to_port == 5432 && aws_security_group_rule.db_from_app.protocol == "tcp" && length(coalesce(aws_security_group_rule.db_from_app.cidr_blocks, [])) == 0
    error_message = "DB ingress must use a single security-group rule, not a CIDR."
  }
  assert {
    condition     = aws_instance.app.metadata_options[0].http_tokens == "required" && aws_instance.app.metadata_options[0].http_protocol_ipv6 == "disabled"
    error_message = "IMDSv2 is required."
  }
  assert {
    condition     = aws_db_instance.notes.auto_minor_version_upgrade
    error_message = "RDS must accept automatic minor updates."
  }
  assert {
    condition     = length(aws_security_group.app.egress) == 3 && alltrue([for rule in aws_security_group.app.egress : rule.from_port == rule.to_port && ((rule.protocol == "tcp" && contains([443, 5432], rule.from_port)) || (rule.protocol == "udp" && rule.from_port == 51820 && length(coalesce(rule.cidr_blocks, [])) == 1 && contains(coalesce(rule.cidr_blocks, []), "198.51.100.8/32")))])
    error_message = "App egress must be HTTPS, scoped WireGuard UDP, or PostgreSQL only."
  }
  assert {
    condition     = alltrue([for rule in aws_security_group.app.egress : rule.from_port != 5432 || length(coalesce(rule.cidr_blocks, [])) == 0])
    error_message = "PostgreSQL egress must target the DB security group."
  }
}
