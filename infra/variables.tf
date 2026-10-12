variable "aws_region" {
  type    = string
  default = "us-east-1"
  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]+$", var.aws_region))
    error_message = "Use a standard AWS region name."
  }
}
variable "project_name" {
  type    = string
  default = "doxx-test-app"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.project_name))
    error_message = "Use 3–31 lowercase letters, digits, or hyphens."
  }
}
variable "tunnel_ip" {
  type = string
  validation {
    condition     = can(cidrnetmask("${var.tunnel_ip}/32")) && startswith(var.tunnel_ip, "10.")
    error_message = "Set the app's doxx 10.x IPv4 address."
  }
}
variable "client_ip" {
  type = string
  validation {
    condition     = can(cidrnetmask("${var.client_ip}/32")) && startswith(var.client_ip, "10.")
    error_message = "Set the selected Mac's doxx 10.x IPv4 address."
  }
}
variable "wg_parameter_name" {
  type    = string
  default = "/doxx-test-app/wg-conf"
  validation {
    condition     = can(regex("^/[a-zA-Z0-9_./-]+$", var.wg_parameter_name))
    error_message = "Use an absolute SSM parameter path."
  }
}
variable "ami_id" {
  type    = string
  default = null
  validation {
    condition     = var.ami_id == null ? true : can(regex("^ami-[0-9a-f]+$", var.ami_id))
    error_message = "Use an AMI ID or null."
  }
}
variable "postgres_version" {
  type    = string
  default = "17.6"
}
