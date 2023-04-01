#!/bin/bash

# Variables
node_exporter_version="1.3.0"
prometheus_version="2.34.0"
node_exporter_url="https://github.com/prometheus/node_exporter/releases/download/v${node_exporter_version}/node_exporter-${node_exporter_version}.linux-amd64.tar.gz"
prometheus_url="https://github.com/prometheus/prometheus/releases/download/v${prometheus_version}/prometheus-${prometheus_version}.linux-amd64.tar.gz"

# Create directories
mkdir -p ~/monitoring/{node_exporter,prometheus}

# Download and install Node Exporter
curl -sSL $node_exporter_url -o ~/monitoring/node_exporter.tar.gz
tar -xzf ~/monitoring/node_exporter.tar.gz -C ~/monitoring/node_exporter --strip-components=1
rm ~/monitoring/node_exporter.tar.gz

# Download and install Prometheus
curl -sSL $prometheus_url -o ~/monitoring/prometheus.tar.gz
tar -xzf ~/monitoring/prometheus.tar.gz -C ~/monitoring/prometheus --strip-components=1
rm ~/monitoring/prometheus.tar.gz

# Create a Prometheus config file
cat > ~/monitoring/prometheus/prometheus.yml <<EOF
global:
  scrape_interval:     15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'node_exporter'
    static_configs:
    - targets: ['localhost:9100']
EOF

# Start Node Exporter
nohup ~/monitoring/node_exporter/node_exporter &

# Start Prometheus
nohup ~/monitoring/prometheus/prometheus --config.file=~/monitoring/prometheus/prometheus.yml &

echo "Node Exporter and Prometheus server are running."
