# ──────────────────────────────────────────────────────────────────────────────
# Production Environment
# High-availability configuration with Multi-AZ database and Redis failover.
# ──────────────────────────────────────────────────────────────────────────────

environment = "production"

# Networking
vpc_cidr = "10.0.0.0/16"
az_count = 2

# Application — bigger tasks, more replicas
task_cpu      = 512
task_memory   = 1024
desired_count = 3
max_count     = 10

# Database — larger instance, Multi-AZ for HA
db_instance_class    = "db.t3.small"
db_allocated_storage = 50
db_multi_az          = true

# Redis — 2 nodes for automatic failover
redis_node_type          = "cache.t3.small"
redis_num_cache_clusters = 2
