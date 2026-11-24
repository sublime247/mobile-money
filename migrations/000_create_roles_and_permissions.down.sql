-- Rollback: 000_create_roles_and_permissions
-- Drops roles, permissions, and role_permissions tables

DROP TABLE IF EXISTS role_permissions CASCADE;
DROP TABLE IF EXISTS permissions CASCADE;
DROP TABLE IF EXISTS roles CASCADE;

