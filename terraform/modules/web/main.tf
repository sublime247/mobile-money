# ──────────────────────────────────────────────────────────────────────────────
# Web Module – ECS Fargate + Application Load Balancer
# Runs the Mobile Money Node.js application behind an ALB.
# ──────────────────────────────────────────────────────────────────────────────

data "aws_region" "current" {}

# ── CloudWatch Log Group ────────────────────────────────────────────────────
resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.project}-${var.environment}"
  retention_in_days = var.log_retention_days

  tags = {
    Environment = var.environment
    Project     = var.project
  }
}

# ── IAM – ECS Task Execution Role ──────────────────────────────────────────
resource "aws_iam_role" "ecs_execution" {
  name = "${var.project}-${var.environment}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })

  tags = {
    Environment = var.environment
    Project     = var.project
  }
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ── IAM – ECS Task Role (for app-level AWS access) ─────────────────────────
resource "aws_iam_role" "ecs_task" {
  name = "${var.project}-${var.environment}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }
    }]
  })

  tags = {
    Environment = var.environment
    Project     = var.project
  }
}

# Grant the task role access to S3 (KYC document uploads)
resource "aws_iam_role_policy" "ecs_task_s3" {
  name = "${var.project}-${var.environment}-s3-access"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ]
      Effect = "Allow"
      Resource = [
        "arn:aws:s3:::${var.s3_bucket_name}",
        "arn:aws:s3:::${var.s3_bucket_name}/*"
      ]
    }]
  })
}

# ── Application Load Balancer ──────────────────────────────────────────────
resource "aws_lb" "main" {
  name               = "${var.project}-${var.environment}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.alb_security_group_id]
  subnets            = var.public_subnet_ids

  tags = {
    Name        = "${var.project}-${var.environment}-alb"
    Environment = var.environment
  }
}

resource "aws_lb_target_group" "app" {
  name        = "${var.project}-${var.environment}-tg"
  port        = var.app_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    healthy_threshold   = 3
    unhealthy_threshold = 3
    interval            = 30
    timeout             = 5
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
  }

  tags = {
    Environment = var.environment
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# ── ECS Cluster ────────────────────────────────────────────────────────────
resource "aws_ecs_cluster" "main" {
  name = "${var.project}-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Environment = var.environment
    Project     = var.project
  }
}

# ── ECS Task Definition ───────────────────────────────────────────────────
resource "aws_ecs_task_definition" "app" {
  family                   = "${var.project}-${var.environment}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "${var.project}-app"
    image     = var.container_image
    essential = true

    portMappings = [{
      containerPort = var.app_port
      protocol      = "tcp"
    }]

    environment = [
      { name = "NODE_ENV", value = var.environment },
      { name = "PORT", value = tostring(var.app_port) },
      { name = "DATABASE_URL", value = var.database_url },
      { name = "REDIS_URL", value = var.redis_url },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.app.name
        "awslogs-region"        = data.aws_region.current.name
        "awslogs-stream-prefix" = "ecs"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "curl -f http://localhost:${var.app_port}/health || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 15
    }
  }])

  tags = {
    Environment = var.environment
    Project     = var.project
  }
}

# ── ECS Service ────────────────────────────────────────────────────────────
resource "aws_ecs_service" "app" {
  name            = "${var.project}-${var.environment}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [var.app_security_group_id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "${var.project}-app"
    container_port   = var.app_port
  }

  depends_on = [aws_lb_listener.http]

  tags = {
    Environment = var.environment
    Project     = var.project
  }
}

# ── Auto Scaling ───────────────────────────────────────────────────────────
resource "aws_appautoscaling_target" "ecs" {
  max_capacity       = var.max_count
  min_capacity       = var.desired_count
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.app.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.project}-${var.environment}-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.ecs.resource_id
  scalable_dimension = aws_appautoscaling_target.ecs.scalable_dimension
  service_namespace  = aws_appautoscaling_target.ecs.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value = 80.0
  }
}
