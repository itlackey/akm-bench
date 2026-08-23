#!/bin/bash
set -euo pipefail
echo 'az storage account management-policy create --account-name mystorage --resource-group myrg --policy "{\"rules\":[{\"enabled\":true,\"name\":\"expire-30d\",\"type\":\"Lifecycle\",\"definition\":{\"actions\":{\"baseBlob\":{\"delete\":{\"daysAfterModificationGreaterThan\":30}}},\"filters\":{\"blobTypes\":[\"blockBlob\"]}}}]}"' >> commands.txt
