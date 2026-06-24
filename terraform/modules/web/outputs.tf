output "alb_dns_name" {
  description = "DNS name of the Application Load Balancer"
  value       = aws_lb.main.dns_name
}

output "alb_zone_id" {
  description = "Hosted zone ID of the ALB (for Route 53 alias records)"
  value       = aws_lb.main.zone_id
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "Name of the ECS service"
  value       = aws_ecs_service.app.name
}

output "codedeploy_app_name" {
  description = "Name of the CodeDeploy application used for ECS deployment rollback"
  value       = aws_codedeploy_app.app[0].name
  condition   = var.enable_code_deploy
}

output "codedeploy_deployment_group_name" {
  description = "Name of the CodeDeploy deployment group used for ECS deployment rollback"
  value       = aws_codedeploy_deployment_group.app[0].deployment_group_name
  condition   = var.enable_code_deploy
}
