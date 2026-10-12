data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_vpc" "default" { default = true }
data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}
data "aws_ssm_parameter" "al2023" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}
locals {
  wg_arn = "arn:${data.aws_partition.current.partition}:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter${var.wg_parameter_name}"
}
resource "aws_security_group" "app" {
  name_prefix = "${var.project_name}-app-"
  description = "No ingress; outbound WireGuard, AWS APIs and private database"
  vpc_id      = data.aws_vpc.default.id
  ingress     = []
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_iam_role" "app" {
  name_prefix        = "${var.project_name}-"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.app.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "secrets" {
  role = aws_iam_role.app.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = local.wg_arn },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = aws_db_instance.notes.master_user_secret[0].secret_arn }
  ] })
}
resource "aws_iam_instance_profile" "app" { role = aws_iam_role.app.name }
resource "aws_instance" "app" {
  ami                         = coalesce(var.ami_id, nonsensitive(data.aws_ssm_parameter.al2023.value))
  instance_type               = "t3.micro"
  subnet_id                   = sort(data.aws_subnets.default.ids)[0]
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user_data.sh.tftpl", {
    region     = var.aws_region
    parameter  = var.wg_parameter_name
    tunnel_ip  = var.tunnel_ip
    client_ip  = var.client_ip
    db_host    = aws_db_instance.notes.address
    secret_arn = aws_db_instance.notes.master_user_secret[0].secret_arn
    app_bundle = filebase64("${path.module}/../.local/app.tar.gz")
  })
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_size           = 8
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }
  credit_specification { cpu_credits = "standard" }
  lifecycle {
    precondition {
      condition     = data.aws_vpc.default.cidr_block == "172.31.0.0/16"
      error_message = "This demo expects the default 172.31.0.0/16 VPC; review routes before using another CIDR."
    }
    precondition {
      condition     = length(data.aws_subnets.default.ids) >= 2
      error_message = "RDS requires subnets in at least two availability zones."
    }
  }
  depends_on = [aws_iam_role_policy.secrets, aws_iam_role_policy_attachment.ssm]
  tags       = { Name = var.project_name }
}
