#!/bin/bash
echo "docker run --name nw-invoicer --restart on-failure:5 --label com.northwind.cost-center=CC-4417 --log-driver local registry.northwind.internal/platform/invoicer:2026.09.1" >> commands.txt
