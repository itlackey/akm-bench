#!/bin/bash
echo "az storage account create --name stpayrollarchive01 --resource-group rg-payroll --location eastus --sku Standard_LRS --tags cost-center=CC-4417 --min-tls-version TLS1_2" >> commands.txt
