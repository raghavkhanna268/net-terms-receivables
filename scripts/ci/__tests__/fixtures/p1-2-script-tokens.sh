#!/bin/bash
# P1.2: Script file with token prefixes - should be caught by text-based scanning

# SHOULD FAIL: Token prefix in variable
TOKEN="shpat_1234567890abcdef"
echo "Using token: $TOKEN"

# SHOULD FAIL: Echo with shop variable
SHOP="example.myshopify.com"
echo "Processing shop: $SHOP"
