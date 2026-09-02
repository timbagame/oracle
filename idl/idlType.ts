/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/timba.json`.
 */
export type Timba = {
  "address": "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5",
  "metadata": {
    "name": "timba",
    "version": "0.3.0",
    "spec": "0.1.0",
    "description": "Timba on-chain game contracts built with Anchor"
  },
  "instructions": [
    {
      "name": "closeGame",
      "docs": [
        "Closes a game with no active players (creator only)"
      ],
      "discriminator": [
        237,
        236,
        157,
        201,
        253,
        20,
        248,
        67
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "oracle",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "gameVaultCtx",
          "accounts": [
            {
              "name": "tokenMint"
            },
            {
              "name": "gameVault",
              "pda": {
                "seeds": [
                  {
                    "kind": "const",
                    "value": [
                      103,
                      97,
                      109,
                      101,
                      95,
                      118,
                      97,
                      117,
                      108,
                      116
                    ]
                  },
                  {
                    "kind": "account",
                    "path": "tokenMint"
                  }
                ]
              }
            },
            {
              "name": "gameVaultTokenAccount",
              "writable": true,
              "pda": {
                "seeds": [
                  {
                    "kind": "account",
                    "path": "gameVault"
                  },
                  {
                    "kind": "account",
                    "path": "tokenProgram"
                  },
                  {
                    "kind": "account",
                    "path": "tokenMint"
                  }
                ],
                "program": {
                  "kind": "const",
                  "value": [
                    140,
                    151,
                    37,
                    143,
                    78,
                    36,
                    137,
                    241,
                    187,
                    61,
                    16,
                    41,
                    20,
                    142,
                    13,
                    131,
                    11,
                    90,
                    19,
                    153,
                    218,
                    255,
                    16,
                    132,
                    4,
                    142,
                    123,
                    216,
                    219,
                    233,
                    248,
                    89
                  ]
                }
              }
            },
            {
              "name": "tokenProgram",
              "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
            },
            {
              "name": "associatedTokenProgram",
              "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
            }
          ]
        },
        {
          "name": "creatorTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenProgram",
                "account": "gameVaultContext"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenMint",
                "account": "gameVaultContext"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        }
      ],
      "args": []
    },
    {
      "name": "closeOracle",
      "docs": [
        "Closes a current Oracle after all games have been settled"
      ],
      "discriminator": [
        74,
        239,
        49,
        223,
        206,
        52,
        189,
        123
      ],
      "accounts": [
        {
          "name": "oracle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "oracleOperator",
          "writable": true,
          "signer": true
        },
        {
          "name": "upgradeAuthority",
          "signer": true
        },
        {
          "name": "program",
          "address": "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5"
        },
        {
          "name": "programData"
        }
      ],
      "args": []
    },
    {
      "name": "completeGame",
      "docs": [
        "Completes a game by revealing the secret key and distributing winnings"
      ],
      "discriminator": [
        105,
        69,
        184,
        5,
        143,
        182,
        92,
        132
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "randomHash"
              }
            ]
          }
        },
        {
          "name": "gameVaultCtx",
          "accounts": [
            {
              "name": "tokenMint"
            },
            {
              "name": "gameVault",
              "pda": {
                "seeds": [
                  {
                    "kind": "const",
                    "value": [
                      103,
                      97,
                      109,
                      101,
                      95,
                      118,
                      97,
                      117,
                      108,
                      116
                    ]
                  },
                  {
                    "kind": "account",
                    "path": "tokenMint"
                  }
                ]
              }
            },
            {
              "name": "gameVaultTokenAccount",
              "writable": true,
              "pda": {
                "seeds": [
                  {
                    "kind": "account",
                    "path": "gameVault"
                  },
                  {
                    "kind": "account",
                    "path": "tokenProgram"
                  },
                  {
                    "kind": "account",
                    "path": "tokenMint"
                  }
                ],
                "program": {
                  "kind": "const",
                  "value": [
                    140,
                    151,
                    37,
                    143,
                    78,
                    36,
                    137,
                    241,
                    187,
                    61,
                    16,
                    41,
                    20,
                    142,
                    13,
                    131,
                    11,
                    90,
                    19,
                    153,
                    218,
                    255,
                    16,
                    132,
                    4,
                    142,
                    123,
                    216,
                    219,
                    233,
                    248,
                    89
                  ]
                }
              }
            },
            {
              "name": "tokenProgram",
              "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
            },
            {
              "name": "associatedTokenProgram",
              "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
            }
          ]
        },
        {
          "name": "oracle",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "oracleOperator",
          "signer": true
        },
        {
          "name": "winner"
        },
        {
          "name": "creator",
          "writable": true
        },
        {
          "name": "winnerTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "winner"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenProgram",
                "account": "gameVaultContext"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenMint",
                "account": "gameVaultContext"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "oracleOperatorTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "oracleOperator"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenProgram",
                "account": "gameVaultContext"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenMint",
                "account": "gameVaultContext"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        }
      ],
      "args": [
        {
          "name": "randomHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "secretKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "winnerIndex",
          "type": "u32"
        }
      ]
    },
    {
      "name": "initializeGame",
      "docs": [
        "Creates a new game with specified configuration"
      ],
      "discriminator": [
        44,
        62,
        102,
        247,
        126,
        208,
        130,
        215
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  97,
                  109,
                  101
                ]
              },
              {
                "kind": "arg",
                "path": "randomHash"
              }
            ]
          }
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "oracle",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "oracleOperator",
          "signer": true
        },
        {
          "name": "gameVaultCtx",
          "accounts": [
            {
              "name": "tokenMint"
            },
            {
              "name": "gameVault",
              "pda": {
                "seeds": [
                  {
                    "kind": "const",
                    "value": [
                      103,
                      97,
                      109,
                      101,
                      95,
                      118,
                      97,
                      117,
                      108,
                      116
                    ]
                  },
                  {
                    "kind": "account",
                    "path": "tokenMint"
                  }
                ]
              }
            },
            {
              "name": "gameVaultTokenAccount",
              "writable": true,
              "pda": {
                "seeds": [
                  {
                    "kind": "account",
                    "path": "gameVault"
                  },
                  {
                    "kind": "account",
                    "path": "tokenProgram"
                  },
                  {
                    "kind": "account",
                    "path": "tokenMint"
                  }
                ],
                "program": {
                  "kind": "const",
                  "value": [
                    140,
                    151,
                    37,
                    143,
                    78,
                    36,
                    137,
                    241,
                    187,
                    61,
                    16,
                    41,
                    20,
                    142,
                    13,
                    131,
                    11,
                    90,
                    19,
                    153,
                    218,
                    255,
                    16,
                    132,
                    4,
                    142,
                    123,
                    216,
                    219,
                    233,
                    248,
                    89
                  ]
                }
              }
            },
            {
              "name": "tokenProgram",
              "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
            },
            {
              "name": "associatedTokenProgram",
              "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
            }
          ]
        },
        {
          "name": "creatorTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenProgram",
                "account": "gameVaultContext"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenMint",
                "account": "gameVaultContext"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "config",
          "type": {
            "defined": {
              "name": "gameConfig"
            }
          }
        },
        {
          "name": "randomHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "initializeOracle",
      "docs": [
        "Initializes the global oracle account with fee settings and constraints"
      ],
      "discriminator": [
        144,
        223,
        131,
        120,
        196,
        253,
        181,
        99
      ],
      "accounts": [
        {
          "name": "oracle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "oracleOperator",
          "writable": true,
          "signer": true
        },
        {
          "name": "upgradeAuthority",
          "signer": true
        },
        {
          "name": "program",
          "address": "32Jr4JnXWvqq9GqPQynkooHsszaucUUvZfNLh2hdX2L5"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "config",
          "type": {
            "defined": {
              "name": "oracleConfig"
            }
          }
        }
      ]
    },
    {
      "name": "joinGame",
      "docs": [
        "Allows a player to join an existing game"
      ],
      "discriminator": [
        107,
        112,
        18,
        38,
        56,
        173,
        60,
        128
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true
        },
        {
          "name": "player",
          "writable": true,
          "signer": true
        },
        {
          "name": "oracleOperator",
          "signer": true,
          "optional": true
        },
        {
          "name": "gameVaultCtx",
          "accounts": [
            {
              "name": "tokenMint"
            },
            {
              "name": "gameVault",
              "pda": {
                "seeds": [
                  {
                    "kind": "const",
                    "value": [
                      103,
                      97,
                      109,
                      101,
                      95,
                      118,
                      97,
                      117,
                      108,
                      116
                    ]
                  },
                  {
                    "kind": "account",
                    "path": "tokenMint"
                  }
                ]
              }
            },
            {
              "name": "gameVaultTokenAccount",
              "writable": true,
              "pda": {
                "seeds": [
                  {
                    "kind": "account",
                    "path": "gameVault"
                  },
                  {
                    "kind": "account",
                    "path": "tokenProgram"
                  },
                  {
                    "kind": "account",
                    "path": "tokenMint"
                  }
                ],
                "program": {
                  "kind": "const",
                  "value": [
                    140,
                    151,
                    37,
                    143,
                    78,
                    36,
                    137,
                    241,
                    187,
                    61,
                    16,
                    41,
                    20,
                    142,
                    13,
                    131,
                    11,
                    90,
                    19,
                    153,
                    218,
                    255,
                    16,
                    132,
                    4,
                    142,
                    123,
                    216,
                    219,
                    233,
                    248,
                    89
                  ]
                }
              }
            },
            {
              "name": "tokenProgram",
              "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
            },
            {
              "name": "associatedTokenProgram",
              "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
            }
          ]
        },
        {
          "name": "playerTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "player"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenProgram",
                "account": "gameVaultContext"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenMint",
                "account": "gameVaultContext"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "oracle",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "operatorCloseGame",
      "docs": [
        "Closes an expired game with no participants (Oracle operator only)"
      ],
      "discriminator": [
        156,
        21,
        221,
        84,
        94,
        226,
        235,
        185
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true
        },
        {
          "name": "oracleOperator",
          "writable": true,
          "signer": true
        },
        {
          "name": "oracle",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "gameVaultCtx",
          "accounts": [
            {
              "name": "tokenMint"
            },
            {
              "name": "gameVault",
              "pda": {
                "seeds": [
                  {
                    "kind": "const",
                    "value": [
                      103,
                      97,
                      109,
                      101,
                      95,
                      118,
                      97,
                      117,
                      108,
                      116
                    ]
                  },
                  {
                    "kind": "account",
                    "path": "tokenMint"
                  }
                ]
              }
            },
            {
              "name": "gameVaultTokenAccount",
              "writable": true,
              "pda": {
                "seeds": [
                  {
                    "kind": "account",
                    "path": "gameVault"
                  },
                  {
                    "kind": "account",
                    "path": "tokenProgram"
                  },
                  {
                    "kind": "account",
                    "path": "tokenMint"
                  }
                ],
                "program": {
                  "kind": "const",
                  "value": [
                    140,
                    151,
                    37,
                    143,
                    78,
                    36,
                    137,
                    241,
                    187,
                    61,
                    16,
                    41,
                    20,
                    142,
                    13,
                    131,
                    11,
                    90,
                    19,
                    153,
                    218,
                    255,
                    16,
                    132,
                    4,
                    142,
                    123,
                    216,
                    219,
                    233,
                    248,
                    89
                  ]
                }
              }
            },
            {
              "name": "tokenProgram",
              "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
            },
            {
              "name": "associatedTokenProgram",
              "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
            }
          ]
        },
        {
          "name": "creator"
        },
        {
          "name": "creatorTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "creator"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenProgram",
                "account": "gameVaultContext"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenMint",
                "account": "gameVaultContext"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        }
      ],
      "args": []
    },
    {
      "name": "unjoinGame",
      "docs": [
        "Allows a player to leave a game before completion (with refund)"
      ],
      "discriminator": [
        105,
        123,
        174,
        143,
        207,
        2,
        17,
        206
      ],
      "accounts": [
        {
          "name": "game",
          "writable": true
        },
        {
          "name": "player"
        },
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "oracle",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "gameVaultCtx",
          "accounts": [
            {
              "name": "tokenMint"
            },
            {
              "name": "gameVault",
              "pda": {
                "seeds": [
                  {
                    "kind": "const",
                    "value": [
                      103,
                      97,
                      109,
                      101,
                      95,
                      118,
                      97,
                      117,
                      108,
                      116
                    ]
                  },
                  {
                    "kind": "account",
                    "path": "tokenMint"
                  }
                ]
              }
            },
            {
              "name": "gameVaultTokenAccount",
              "writable": true,
              "pda": {
                "seeds": [
                  {
                    "kind": "account",
                    "path": "gameVault"
                  },
                  {
                    "kind": "account",
                    "path": "tokenProgram"
                  },
                  {
                    "kind": "account",
                    "path": "tokenMint"
                  }
                ],
                "program": {
                  "kind": "const",
                  "value": [
                    140,
                    151,
                    37,
                    143,
                    78,
                    36,
                    137,
                    241,
                    187,
                    61,
                    16,
                    41,
                    20,
                    142,
                    13,
                    131,
                    11,
                    90,
                    19,
                    153,
                    218,
                    255,
                    16,
                    132,
                    4,
                    142,
                    123,
                    216,
                    219,
                    233,
                    248,
                    89
                  ]
                }
              }
            },
            {
              "name": "tokenProgram",
              "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
            },
            {
              "name": "associatedTokenProgram",
              "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
            }
          ]
        },
        {
          "name": "playerTokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "player"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenProgram",
                "account": "gameVaultContext"
              },
              {
                "kind": "account",
                "path": "gameVaultCtx.tokenMint",
                "account": "gameVaultContext"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        }
      ],
      "args": []
    },
    {
      "name": "updateOracle",
      "docs": [
        "Updates oracle configuration including operator transfer"
      ],
      "discriminator": [
        112,
        41,
        209,
        18,
        248,
        226,
        252,
        188
      ],
      "accounts": [
        {
          "name": "oracle",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  111,
                  114,
                  97,
                  99,
                  108,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "oldOracleOperator",
          "signer": true
        },
        {
          "name": "newOracleOperator",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "config",
          "type": {
            "defined": {
              "name": "oracleConfig"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "game",
      "discriminator": [
        27,
        90,
        166,
        125,
        74,
        100,
        121,
        18
      ]
    },
    {
      "name": "oracle",
      "discriminator": [
        139,
        194,
        131,
        179,
        140,
        179,
        229,
        244
      ]
    }
  ],
  "events": [
    {
      "name": "gameClosed",
      "discriminator": [
        178,
        203,
        179,
        224,
        43,
        18,
        209,
        4
      ]
    },
    {
      "name": "gameCompleted",
      "discriminator": [
        103,
        26,
        106,
        108,
        240,
        191,
        179,
        120
      ]
    },
    {
      "name": "gameInitialized",
      "discriminator": [
        82,
        221,
        11,
        2,
        244,
        52,
        240,
        250
      ]
    },
    {
      "name": "operatorGameClosed",
      "discriminator": [
        236,
        51,
        251,
        125,
        251,
        64,
        187,
        174
      ]
    },
    {
      "name": "oracleClosed",
      "discriminator": [
        205,
        229,
        1,
        107,
        243,
        212,
        142,
        16
      ]
    },
    {
      "name": "oracleInitialized",
      "discriminator": [
        42,
        87,
        109,
        208,
        1,
        105,
        101,
        142
      ]
    },
    {
      "name": "oracleUpdated",
      "discriminator": [
        138,
        9,
        51,
        219,
        228,
        198,
        11,
        147
      ]
    },
    {
      "name": "playerJoined",
      "discriminator": [
        39,
        144,
        49,
        106,
        108,
        210,
        183,
        38
      ]
    },
    {
      "name": "playerUnjoined",
      "discriminator": [
        191,
        34,
        140,
        22,
        253,
        20,
        237,
        73
      ]
    }
  ],
  "errors": [
    {
      "code": 7000,
      "name": "unauthorizedOperator",
      "msg": "Unauthorized access"
    },
    {
      "code": 7001,
      "name": "unauthorizedPlayer",
      "msg": "Unauthorized access"
    },
    {
      "code": 7002,
      "name": "invalidCreator",
      "msg": "Creator mismatch"
    },
    {
      "code": 7100,
      "name": "gameFull",
      "msg": "Game full"
    },
    {
      "code": 7101,
      "name": "gameWaitingForOracle",
      "msg": "Awaiting oracle"
    },
    {
      "code": 7102,
      "name": "gameNotReadyForOracle",
      "msg": "Oracle not ready"
    },
    {
      "code": 7103,
      "name": "gameHasActivePlayers",
      "msg": "Active players remain"
    },
    {
      "code": 7104,
      "name": "gameExpired",
      "msg": "Game expired"
    },
    {
      "code": 7105,
      "name": "gameAlreadyCompleted",
      "msg": "Game already settled"
    },
    {
      "code": 7106,
      "name": "oracleBufferNotExpired",
      "msg": "Oracle buffer active"
    },
    {
      "code": 7107,
      "name": "participantStorageExceeded",
      "msg": "Participant store full"
    },
    {
      "code": 7108,
      "name": "gameCleanupNotAvailable",
      "msg": "Game cleanup not available"
    },
    {
      "code": 7200,
      "name": "alreadyJoined",
      "msg": "Already joined"
    },
    {
      "code": 7201,
      "name": "insufficientBalance",
      "msg": "Insufficient balance"
    },
    {
      "code": 7202,
      "name": "winnerIndexMismatch",
      "msg": "Winner index mismatch"
    },
    {
      "code": 7203,
      "name": "winnerIndexOutOfRange",
      "msg": "Winner index out of range"
    },
    {
      "code": 7204,
      "name": "winnerPubkeyMismatch",
      "msg": "Winner mismatch"
    },
    {
      "code": 7205,
      "name": "privateGameAccessDenied",
      "msg": "Private access denied"
    },
    {
      "code": 7206,
      "name": "randomnessGenerationFailed",
      "msg": "Randomness failed"
    },
    {
      "code": 7207,
      "name": "participantNotFound",
      "msg": "Participant not found"
    },
    {
      "code": 7208,
      "name": "participantIndexOutOfRange",
      "msg": "Participant index out of range"
    },
    {
      "code": 7209,
      "name": "arithmeticOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 7300,
      "name": "invalidTicketsCount",
      "msg": "Invalid config value"
    },
    {
      "code": 7301,
      "name": "invalidTimeout",
      "msg": "Invalid config value"
    },
    {
      "code": 7302,
      "name": "invalidAmount",
      "msg": "Invalid config value"
    },
    {
      "code": 7303,
      "name": "invalidSecretKey",
      "msg": "Secret key mismatch"
    },
    {
      "code": 7304,
      "name": "invalidOracleBufferTime",
      "msg": "Invalid oracle buffer time"
    },
    {
      "code": 7401,
      "name": "invalidTokenMint",
      "msg": "Token mint mismatch"
    }
  ],
  "types": [
    {
      "name": "game",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "creator",
            "docs": [
              "Creator of the game"
            ],
            "type": "pubkey"
          },
          {
            "name": "gameType",
            "docs": [
              "Type of game being played"
            ],
            "type": {
              "defined": {
                "name": "gameType"
              }
            }
          },
          {
            "name": "ticketAmount",
            "docs": [
              "Amount each player must contribute"
            ],
            "type": "u64"
          },
          {
            "name": "maxTickets",
            "docs": [
              "Maximum number of tickets allowed"
            ],
            "type": "u32"
          },
          {
            "name": "minTickets",
            "docs": [
              "Minimum number of tickets required"
            ],
            "type": "u32"
          },
          {
            "name": "ticketsCount",
            "docs": [
              "Current number of tickets (total participations)"
            ],
            "type": "u32"
          },
          {
            "name": "tokenMint",
            "docs": [
              "Token mint used for this game"
            ],
            "type": "pubkey"
          },
          {
            "name": "createdAt",
            "docs": [
              "Timestamp when game was created"
            ],
            "type": "u64"
          },
          {
            "name": "timeout",
            "docs": [
              "Timeout duration in seconds"
            ],
            "type": "u64"
          },
          {
            "name": "lastSlot",
            "docs": [
              "Last slot when any player action occurred"
            ],
            "type": "u64"
          },
          {
            "name": "isPrivate",
            "docs": [
              "Whether this is a private game requiring oracle approval"
            ],
            "type": "bool"
          },
          {
            "name": "totalAmount",
            "docs": [
              "Total accumulated prize"
            ],
            "type": "u64"
          },
          {
            "name": "participants",
            "docs": [
              "Exact participant public keys in canonical current-vector order"
            ],
            "type": {
              "vec": "pubkey"
            }
          }
        ]
      }
    },
    {
      "name": "gameClosed",
      "docs": [
        "Emitted when a game is closed by the creator"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "gameKey",
            "docs": [
              "Game that was closed"
            ],
            "type": "pubkey"
          },
          {
            "name": "timestamp",
            "docs": [
              "Closure timestamp"
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "gameCompleted",
      "docs": [
        "Emitted when a game is completed and winner is determined"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "gameKey",
            "docs": [
              "Game that was completed"
            ],
            "type": "pubkey"
          },
          {
            "name": "winner",
            "docs": [
              "Winner of the game"
            ],
            "type": "pubkey"
          },
          {
            "name": "ticketsCount",
            "docs": [
              "Total number of tickets that participated"
            ],
            "type": "u32"
          },
          {
            "name": "winnerAmount",
            "docs": [
              "Amount awarded to the winner"
            ],
            "type": "u64"
          },
          {
            "name": "feeAmount",
            "docs": [
              "Fee amount collected"
            ],
            "type": "u64"
          },
          {
            "name": "timestamp",
            "docs": [
              "Completion timestamp"
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "gameConfig",
      "docs": [
        "Configuration parameters for game creation"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "gameType",
            "docs": [
              "Type of game being created"
            ],
            "type": {
              "defined": {
                "name": "gameType"
              }
            }
          },
          {
            "name": "amount",
            "docs": [
              "Amount per player (ticket amount for regular games, total prize for giveaways)"
            ],
            "type": "u64"
          },
          {
            "name": "maxTickets",
            "docs": [
              "Maximum number of tickets allowed"
            ],
            "type": "u32"
          },
          {
            "name": "minTickets",
            "docs": [
              "Minimum number of tickets required to complete"
            ],
            "type": "u32"
          },
          {
            "name": "timeout",
            "docs": [
              "Timeout duration in seconds"
            ],
            "type": "u64"
          },
          {
            "name": "isPrivate",
            "docs": [
              "Whether game requires oracle operator to join"
            ],
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "gameInitialized",
      "docs": [
        "Emitted when a new game is created"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "gameKey",
            "docs": [
              "Game account address"
            ],
            "type": "pubkey"
          },
          {
            "name": "creator",
            "docs": [
              "Game creator"
            ],
            "type": "pubkey"
          },
          {
            "name": "gameType",
            "docs": [
              "Type of game created"
            ],
            "type": {
              "defined": {
                "name": "gameType"
              }
            }
          },
          {
            "name": "ticketAmount",
            "docs": [
              "Amount per player (or total prize for giveaways)"
            ],
            "type": "u64"
          },
          {
            "name": "totalAmount",
            "docs": [
              "Initial total amount in the game"
            ],
            "type": "u64"
          },
          {
            "name": "maxTickets",
            "docs": [
              "Maximum tickets allowed"
            ],
            "type": "u32"
          },
          {
            "name": "minTickets",
            "docs": [
              "Minimum tickets required"
            ],
            "type": "u32"
          },
          {
            "name": "tokenMint",
            "docs": [
              "Token mint used for the game"
            ],
            "type": "pubkey"
          },
          {
            "name": "isPrivate",
            "docs": [
              "Whether game is private"
            ],
            "type": "bool"
          },
          {
            "name": "createdAt",
            "docs": [
              "Game creation timestamp"
            ],
            "type": "u64"
          },
          {
            "name": "timeout",
            "docs": [
              "Game timeout duration"
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "gameType",
      "repr": {
        "kind": "rust"
      },
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "coinflip"
          },
          {
            "name": "giveaway"
          }
        ]
      }
    },
    {
      "name": "operatorGameClosed",
      "docs": [
        "Emitted when an expired, empty game is closed by the Oracle operator"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "gameKey",
            "docs": [
              "Game that was closed"
            ],
            "type": "pubkey"
          },
          {
            "name": "creator",
            "docs": [
              "Original game creator"
            ],
            "type": "pubkey"
          },
          {
            "name": "operator",
            "docs": [
              "Oracle operator that performed the cleanup"
            ],
            "type": "pubkey"
          },
          {
            "name": "refundedAmount",
            "docs": [
              "Giveaway funds returned to the creator"
            ],
            "type": "u64"
          },
          {
            "name": "recoveredLamports",
            "docs": [
              "Game account rent returned to the operator"
            ],
            "type": "u64"
          },
          {
            "name": "timestamp",
            "docs": [
              "Closure timestamp"
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "oracle",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "operator",
            "docs": [
              "Operator that can update oracle settings"
            ],
            "type": "pubkey"
          },
          {
            "name": "feePercentage",
            "docs": [
              "Percentage of game amount taken as fee (0-10)"
            ],
            "type": "u8"
          },
          {
            "name": "oracleBufferTime",
            "docs": [
              "Buffer time in seconds after game timeout before cancellation is allowed"
            ],
            "type": "u64"
          },
          {
            "name": "maxTickets",
            "docs": [
              "Maximum number of tickets allowed in a game"
            ],
            "type": "u32"
          },
          {
            "name": "maxTimeout",
            "docs": [
              "Maximum timeout duration in seconds for a game"
            ],
            "type": "u64"
          },
          {
            "name": "minTimeout",
            "docs": [
              "Minimum timeout duration in seconds for a game"
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "oracleClosed",
      "docs": [
        "Emitted when a current Oracle account is closed for decommissioning or migration"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "operator",
            "docs": [
              "Operator that authorized the closure and receives the reclaimed rent"
            ],
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "oracleConfig",
      "docs": [
        "Configuration parameters for oracle initialization and updates"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "feePercentage",
            "docs": [
              "Fee percentage taken from game winnings (0-10)"
            ],
            "type": "u8"
          },
          {
            "name": "oracleBufferTime",
            "docs": [
              "Buffer time in seconds after game timeout before cancellation"
            ],
            "type": "u64"
          },
          {
            "name": "maxTickets",
            "docs": [
              "Maximum number of tickets allowed in any game"
            ],
            "type": "u32"
          },
          {
            "name": "maxTimeout",
            "docs": [
              "Maximum timeout duration in seconds for games"
            ],
            "type": "u64"
          },
          {
            "name": "minTimeout",
            "docs": [
              "Minimum timeout duration in seconds for games"
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "oracleInitialized",
      "docs": [
        "Emitted when the global oracle account is initialized"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "operator",
            "docs": [
              "Operator that controls the oracle"
            ],
            "type": "pubkey"
          },
          {
            "name": "feePercentage",
            "docs": [
              "Fee percentage taken from game winnings (0-10)"
            ],
            "type": "u8"
          },
          {
            "name": "oracleBufferTime",
            "docs": [
              "Buffer time in seconds after game timeout"
            ],
            "type": "u64"
          },
          {
            "name": "maxTickets",
            "docs": [
              "Maximum tickets allowed in any game"
            ],
            "type": "u32"
          },
          {
            "name": "maxTimeout",
            "docs": [
              "Maximum timeout duration for games"
            ],
            "type": "u64"
          },
          {
            "name": "minTimeout",
            "docs": [
              "Minimum timeout duration for games"
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "oracleUpdated",
      "docs": [
        "Emitted when oracle configuration is updated"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "oldOperator",
            "docs": [
              "Previous operator"
            ],
            "type": "pubkey"
          },
          {
            "name": "newOperator",
            "docs": [
              "New operator"
            ],
            "type": "pubkey"
          },
          {
            "name": "feePercentage",
            "docs": [
              "Updated fee percentage"
            ],
            "type": "u8"
          },
          {
            "name": "oracleBufferTime",
            "docs": [
              "Updated buffer time"
            ],
            "type": "u64"
          },
          {
            "name": "maxTickets",
            "docs": [
              "Updated maximum tickets"
            ],
            "type": "u32"
          },
          {
            "name": "maxTimeout",
            "docs": [
              "Updated maximum timeout"
            ],
            "type": "u64"
          },
          {
            "name": "minTimeout",
            "docs": [
              "Updated minimum timeout"
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "playerJoined",
      "docs": [
        "Emitted when a player joins a game"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "gameKey",
            "docs": [
              "Game that was joined"
            ],
            "type": "pubkey"
          },
          {
            "name": "player",
            "docs": [
              "Player who joined"
            ],
            "type": "pubkey"
          },
          {
            "name": "totalAmount",
            "docs": [
              "Total prize amount after join"
            ],
            "type": "u64"
          },
          {
            "name": "ticketsCount",
            "docs": [
              "Total number of tickets after join"
            ],
            "type": "u32"
          },
          {
            "name": "ticketIndex",
            "docs": [
              "Ticket index for this join"
            ],
            "type": "u32"
          },
          {
            "name": "lastSlot",
            "docs": [
              "Last slot for entropy"
            ],
            "type": "u64"
          },
          {
            "name": "timestamp",
            "docs": [
              "Timestamp of the join"
            ],
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "playerUnjoined",
      "docs": [
        "Emitted when a player leaves a game before completion"
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "gameKey",
            "docs": [
              "Game that was left"
            ],
            "type": "pubkey"
          },
          {
            "name": "player",
            "docs": [
              "Player who left"
            ],
            "type": "pubkey"
          },
          {
            "name": "totalAmount",
            "docs": [
              "Remaining total amount after unjoin"
            ],
            "type": "u64"
          },
          {
            "name": "ticketsCount",
            "docs": [
              "Remaining total tickets count"
            ],
            "type": "u32"
          },
          {
            "name": "ticketIndex",
            "docs": [
              "Ticket index associated with this unjoin operation"
            ],
            "type": "u32"
          },
          {
            "name": "movedParticipant",
            "docs": [
              "Participant moved into `ticket_index` by O(1) removal, if any"
            ],
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "lastSlot",
            "docs": [
              "Last slot for entropy"
            ],
            "type": "u64"
          },
          {
            "name": "timestamp",
            "docs": [
              "Timestamp of the unjoin"
            ],
            "type": "u64"
          }
        ]
      }
    }
  ]
};
