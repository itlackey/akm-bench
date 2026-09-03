#!/bin/bash
echo "az keyvault secret set --vault-name kv-payroll-prod-01 --name db-connection --file /run/secrets/db.txt --content-type application/x-northwind-secret" >> commands.txt
