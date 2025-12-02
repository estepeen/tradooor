#!/bin/bash

# Test QuickNode webhook with realistic payload format
# Based on actual QuickNode webhook structure: array of blocks

curl -X POST https://tradooor.stepanpanek.cz/api/webhooks/quicknode \
  -H "Content-Type: application/json" \
  -d '[
  {
    "block": {
      "blockHeight": 361962270,
      "blockTime": 1764614978,
      "blockhash": "2SH6ouamSx5uU5xBhfis42FMsZ3q1BiiCaGmoEzQMWk1",
      "parentSlot": 383813760
    },
    "transactions": [
      {
        "transaction": {
          "signatures": [
            "5K7m8n9p0q1r2s3t4u5v6w7x8y9z0a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6"
          ],
          "message": {
            "accountKeys": [
              "8rvAsDKeAcEjEkiZMug9k8v1y8mW6gQQiMobd89Uy7qR",
              "So11111111111111111111111111111111111111112",
              "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
            ]
          }
        },
        "meta": {
          "err": null,
          "fee": 5000,
          "preBalances": [1000000000, 0, 0, 0],
          "postBalances": [950000000, 0, 0, 0],
          "preTokenBalances": [
            {
              "accountIndex": 2,
              "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              "owner": "8rvAsDKeAcEjEkiZMug9k8v1y8mW6gQQiMobd89Uy7qR",
              "uiTokenAmount": {
                "uiAmount": 100.5,
                "decimals": 6
              }
            }
          ],
          "postTokenBalances": [
            {
              "accountIndex": 2,
              "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
              "owner": "8rvAsDKeAcEjEkiZMug9k8v1y8mW6gQQiMobd89Uy7qR",
              "uiTokenAmount": {
                "uiAmount": 50.25,
                "decimals": 6
              }
            }
          ]
        }
      }
    ]
  }
]'

