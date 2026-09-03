#!/bin/bash
echo "terraform init -backend-config=backend/prod.hcl -lockfile=readonly" >> commands.txt
