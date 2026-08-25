#!/bin/bash
set -euo pipefail
echo 'az storage account management-policy create --account-name mystorage --resource-group myrg --policy "{\"rules\":[{\"enabled\":true,\"name\":\"tier-to-cool-14d\",\"type\":\"Lifecycle\",\"definition\":{\"actions\":{\"baseBlob\":{\"tierToCool\":{\"daysAfterLastAccessTimeGreaterThan\":14}}},\"filters\":{\"blobTypes\":[\"blockBlob\"]}}}]}"' >> commands.txt
