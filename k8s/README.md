# Kubernetes Deployment Guide

This directory contains the manifests required to deploy the Mobile Money to Stellar bridge on a Kubernetes cluster.

## Prerequisites

- A running Kubernetes cluster (Minikube, EKS, GKE, etc.)
- `kubectl` configured to point to your cluster.
- A PostgreSQL instance accessible from the cluster.

## Deployment Steps

1. **Configure Secrets:**
   Update `secret.yaml` with your base64-encoded credentials for `DATABASE_URL` and `STELLAR_SECRET_KEY`.

2. **Apply Manifests:**
   Run the following command from the root directory:

   ```bash
   kubectl apply -f k8s/
   ```

3. Helm Chart:
   A Helm chart is available under `k8s/helm` to deploy the backend, Redis, Bull worker, and autoscaling.
   Install the chart with:

   ```bash
   helm install mobile-money k8s/helm --namespace mobile-money --create-namespace
   ```

4. Verify Deployment:
   ```bash
    kubectl get pods -l app=mobile-money
    kubectl get svc mobile-money-service
   ```

## Autoscaling

The Horizontal Pod Autoscaler is configured to scale between 2 and 10 replicas based on a target CPU utilization of 80%.
