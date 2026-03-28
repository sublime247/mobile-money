# ──────────────────────────────────────────────────────────────────────────────
# Staging Environment
# Lean, cost-effective configuration for development and QA.
# ──────────────────────────────────────────────────────────────────────────────

environment = "staging"

# Networking
vpc_cidr = "10.0.0.0/16"
az_count = 2

# Application — small tasks, minimal replicas
task_cpu      = 256
task_memory   = 512
desired_count = 1
max_count     = 3

# Database — smallest instance, single-AZ
db_instance_class    = "db.t3.micro"
db_allocated_storage = 20
db_multi_az          = false

# Redis — single node
redis_node_type          = "cache.t3.micro"
redis_num_cache_clusters = 1
