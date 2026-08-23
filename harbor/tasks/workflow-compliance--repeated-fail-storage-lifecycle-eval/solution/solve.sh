#!/bin/bash
set -euo pipefail
echo 'az storage account management-policy create --account-name storagelogs --resource-group ops-rg --policy "{\"rules\":[{\"enabled\":true,\"name\":\"expire-90d\",\"type\":\"Lifecycle\",\"definition\":{\"actions\":{\"baseBlob\":{\"delete\":{\"daysAfterModificationGreaterThan\":90}}},\"filters\":{\"blobTypes\":[\"blockBlob\"],\"prefixMatch\":[\"logs-archive\"]}}}]}"' >> commands.txt
