resource "aws_security_group" "db" {
  name_prefix = "${var.project_name}-db-"
  description = "Postgres from app security group only"
  vpc_id      = data.aws_vpc.default.id
}
resource "aws_security_group_rule" "db_from_app" {
  type                     = "ingress"
  security_group_id        = aws_security_group.db.id
  from_port                = 5432
  to_port                  = 5432
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.app.id
}
resource "aws_db_subnet_group" "notes" {
  name_prefix = "${var.project_name}-"
  subnet_ids  = data.aws_subnets.default.ids
}
resource "aws_db_instance" "notes" {
  identifier_prefix           = "${var.project_name}-"
  engine                      = "postgres"
  engine_version              = var.postgres_version
  auto_minor_version_upgrade  = true
  instance_class              = "db.t4g.micro"
  allocated_storage           = 20
  storage_type                = "gp3"
  storage_encrypted           = true
  db_name                     = "notes"
  username                    = "notes_admin"
  manage_master_user_password = true
  db_subnet_group_name        = aws_db_subnet_group.notes.name
  vpc_security_group_ids      = [aws_security_group.db.id]
  publicly_accessible         = false
  multi_az                    = false
  backup_retention_period     = 0
  deletion_protection         = false
  skip_final_snapshot         = true
  delete_automated_backups    = true
  apply_immediately           = true
}
