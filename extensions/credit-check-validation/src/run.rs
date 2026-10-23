use crate::schema;
use shopify_function::prelude::*;
use shopify_function::scalars::JsonValue;
use shopify_function::Result;

const ERROR_MSG_ON_HOLD: &str = "Your account is currently on hold. Please contact us to resolve any outstanding issues before placing an order.";
const ERROR_MSG_OVER_LIMIT: &str = "This order would exceed your credit limit. Please contact us to discuss your account or make a payment on outstanding invoices.";

#[derive(Default, PartialEq, Clone)]
pub struct CreditStatus {
    pub schema_version: Option<i32>,
    pub currency_code: Option<String>,
    pub hold: Option<bool>,
    pub hold_reason_code: Option<String>,
    pub limit_paise: Option<String>,
    pub exposure_paise: Option<String>,
    pub updated_at: Option<String>,
}

impl CreditStatus {
    fn from_json_value(json_value: &JsonValue) -> Self {
        if let JsonValue::Object(obj) = json_value {
            CreditStatus {
                schema_version: obj
                    .get("schemaVersion")
                    .and_then(|v| match v {
                        JsonValue::Number(n) => Some(*n as i32),
                        _ => None,
                    }),
                currency_code: obj
                    .get("currencyCode")
                    .and_then(|v| match v {
                        JsonValue::String(s) => Some(s.clone()),
                        _ => None,
                    }),
                hold: obj
                    .get("hold")
                    .and_then(|v| match v {
                        JsonValue::Boolean(b) => Some(*b),
                        _ => None,
                    }),
                hold_reason_code: obj
                    .get("holdReasonCode")
                    .and_then(|v| match v {
                        JsonValue::String(s) => Some(s.clone()),
                        JsonValue::Null => None,
                        _ => None,
                    }),
                limit_paise: obj
                    .get("limitPaise")
                    .and_then(|v| match v {
                        JsonValue::String(s) => Some(s.clone()),
                        _ => None,
                    }),
                exposure_paise: obj
                    .get("exposurePaise")
                    .and_then(|v| match v {
                        JsonValue::String(s) => Some(s.clone()),
                        _ => None,
                    }),
                updated_at: obj
                    .get("updatedAt")
                    .and_then(|v| match v {
                        JsonValue::String(s) => Some(s.clone()),
                        _ => None,
                    }),
            }
        } else {
            CreditStatus::default()
        }
    }
}

fn parse_paise(s: &str) -> Option<u64> {
    s.parse::<u64>().ok()
}

fn get_cart_total_paise(amount: &Decimal) -> Option<u64> {
    let amount_f64 = amount.as_f64();
    if amount_f64 < 0.0 || amount_f64 > 1e18 {
        return None;
    }
    Some((amount_f64 * 100.0).round() as u64)
}

fn create_error(message: &str) -> schema::FunctionRunResult {
    schema::FunctionRunResult {
        errors: vec![schema::FunctionError {
            localized_message: message.to_string(),
            target: "$.cart".to_string(),
        }],
    }
}

fn pass() -> schema::FunctionRunResult {
    schema::FunctionRunResult { errors: vec![] }
}

fn evaluate_credit_status(
    credit_status: &CreditStatus,
    cart_currency: &str,
    cart_total_paise: u64,
) -> schema::FunctionRunResult {
    if credit_status.schema_version.is_none() {
        return pass();
    }
    let schema_version = credit_status.schema_version.unwrap();
    if schema_version != 1 {
        return pass();
    }

    if credit_status.hold == Some(true) {
        return create_error(ERROR_MSG_ON_HOLD);
    }

    let status_currency = match &credit_status.currency_code {
        Some(c) => c.as_str(),
        None => return pass(),
    };

    if status_currency != cart_currency {
        return pass();
    }

    let limit_paise = match &credit_status.limit_paise {
        Some(s) => match parse_paise(s) {
            Some(v) => v,
            None => return pass(),
        },
        None => return pass(),
    };

    let exposure_paise = match &credit_status.exposure_paise {
        Some(s) => match parse_paise(s) {
            Some(v) => v,
            None => return pass(),
        },
        None => return pass(),
    };

    let total_exposure = exposure_paise.saturating_add(cart_total_paise);

    if total_exposure > limit_paise {
        return create_error(ERROR_MSG_OVER_LIMIT);
    }

    pass()
}

#[shopify_function]
fn run(input: schema::run::Input) -> Result<schema::FunctionRunResult> {
    let cart = input.cart();

    let cart_currency = cart.cost().total_amount().currency_code().to_string();
    let cart_total_amount = cart.cost().total_amount().amount();

    let cart_total_paise = match get_cart_total_paise(cart_total_amount) {
        Some(v) => v,
        None => return Ok(pass()),
    };

    let buyer_identity = match cart.buyer_identity() {
        Some(bi) => bi,
        None => return Ok(pass()),
    };

    if let Some(purchasing_company) = buyer_identity.purchasing_company() {
        if let Some(location) = purchasing_company.location() {
            if let Some(metafield) = location.metafield() {
                if let Some(json_value) = metafield.json_value() {
                    let credit_status = CreditStatus::from_json_value(json_value);
                    return Ok(evaluate_credit_status(
                        &credit_status,
                        &cart_currency,
                        cart_total_paise,
                    ));
                }
            }
        }
        return Ok(pass());
    }

    if let Some(customer) = buyer_identity.customer() {
        if let Some(metafield) = customer.metafield() {
            if let Some(json_value) = metafield.json_value() {
                let credit_status = CreditStatus::from_json_value(json_value);
                return Ok(evaluate_credit_status(
                    &credit_status,
                    &cart_currency,
                    cart_total_paise,
                ));
            }
        }
    }

    Ok(pass())
}

#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::{run_function_with_input, Result};

    fn run_test(input_json: &str) -> Result<schema::FunctionRunResult> {
        run_function_with_input(run, input_json)
    }

    #[test]
    fn test_no_metafield_passes() {
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "amount": "100.00",
                        "currencyCode": "INR"
                    }
                },
                "buyerIdentity": {
                    "customer": {
                        "metafield": null
                    },
                    "purchasingCompany": null
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.errors.is_empty(), "No metafield should pass");
    }

    #[test]
    fn test_guest_checkout_passes() {
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "amount": "100.00",
                        "currencyCode": "INR"
                    }
                },
                "buyerIdentity": null
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.errors.is_empty(), "Guest checkout should pass");
    }

    #[test]
    fn test_hold_blocks() {
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "amount": "100.00",
                        "currencyCode": "INR"
                    }
                },
                "buyerIdentity": {
                    "customer": {
                        "metafield": {
                            "jsonValue": {
                                "schemaVersion": 1,
                                "currencyCode": "INR",
                                "hold": true,
                                "holdReasonCode": "PAYMENT_OVERDUE",
                                "limitPaise": "10000000",
                                "exposurePaise": "0",
                                "updatedAt": "2026-10-23T00:00:00Z"
                            }
                        }
                    },
                    "purchasingCompany": null
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert_eq!(result.errors.len(), 1, "Hold should block");
        assert!(result.errors[0].localized_message.contains("on hold"));
    }

    #[test]
    fn test_under_limit_passes() {
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "amount": "1000.00",
                        "currencyCode": "INR"
                    }
                },
                "buyerIdentity": {
                    "customer": {
                        "metafield": {
                            "jsonValue": {
                                "schemaVersion": 1,
                                "currencyCode": "INR",
                                "hold": false,
                                "holdReasonCode": null,
                                "limitPaise": "10000000",
                                "exposurePaise": "5000000",
                                "updatedAt": "2026-10-23T00:00:00Z"
                            }
                        }
                    },
                    "purchasingCompany": null
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.errors.is_empty(), "Under limit should pass");
    }

    #[test]
    fn test_over_limit_blocks() {
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "amount": "60000.00",
                        "currencyCode": "INR"
                    }
                },
                "buyerIdentity": {
                    "customer": {
                        "metafield": {
                            "jsonValue": {
                                "schemaVersion": 1,
                                "currencyCode": "INR",
                                "hold": false,
                                "holdReasonCode": null,
                                "limitPaise": "10000000",
                                "exposurePaise": "5000000",
                                "updatedAt": "2026-10-23T00:00:00Z"
                            }
                        }
                    },
                    "purchasingCompany": null
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert_eq!(result.errors.len(), 1, "Over limit should block");
        assert!(result.errors[0].localized_message.contains("credit limit"));
    }

    #[test]
    fn test_exactly_at_limit_passes() {
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "amount": "50000.00",
                        "currencyCode": "INR"
                    }
                },
                "buyerIdentity": {
                    "customer": {
                        "metafield": {
                            "jsonValue": {
                                "schemaVersion": 1,
                                "currencyCode": "INR",
                                "hold": false,
                                "holdReasonCode": null,
                                "limitPaise": "10000000",
                                "exposurePaise": "5000000",
                                "updatedAt": "2026-10-23T00:00:00Z"
                            }
                        }
                    },
                    "purchasingCompany": null
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.errors.is_empty(), "Exactly at limit should pass");
    }

    #[test]
    fn test_currency_mismatch_passes() {
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "amount": "60000.00",
                        "currencyCode": "USD"
                    }
                },
                "buyerIdentity": {
                    "customer": {
                        "metafield": {
                            "jsonValue": {
                                "schemaVersion": 1,
                                "currencyCode": "INR",
                                "hold": false,
                                "holdReasonCode": null,
                                "limitPaise": "10000000",
                                "exposurePaise": "5000000",
                                "updatedAt": "2026-10-23T00:00:00Z"
                            }
                        }
                    },
                    "purchasingCompany": null
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.errors.is_empty(), "Currency mismatch should pass (fail-open)");
    }

    #[test]
    fn test_malformed_json_passes() {
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "amount": "100.00",
                        "currencyCode": "INR"
                    }
                },
                "buyerIdentity": {
                    "customer": {
                        "metafield": {
                            "jsonValue": {
                                "notARealField": "garbage"
                            }
                        }
                    },
                    "purchasingCompany": null
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.errors.is_empty(), "Malformed JSON should pass (fail-open)");
    }

    #[test]
    fn test_b2b_location_metafield_used() {
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "amount": "100.00",
                        "currencyCode": "INR"
                    }
                },
                "buyerIdentity": {
                    "customer": {
                        "metafield": {
                            "jsonValue": {
                                "schemaVersion": 1,
                                "currencyCode": "INR",
                                "hold": false,
                                "holdReasonCode": null,
                                "limitPaise": "10000000",
                                "exposurePaise": "0",
                                "updatedAt": "2026-10-23T00:00:00Z"
                            }
                        }
                    },
                    "purchasingCompany": {
                        "location": {
                            "metafield": {
                                "jsonValue": {
                                    "schemaVersion": 1,
                                    "currencyCode": "INR",
                                    "hold": true,
                                    "holdReasonCode": "MANUAL_HOLD",
                                    "limitPaise": "10000000",
                                    "exposurePaise": "0",
                                    "updatedAt": "2026-10-23T00:00:00Z"
                                }
                            }
                        }
                    }
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert_eq!(result.errors.len(), 1, "B2B location metafield should take precedence (hold=true)");
        assert!(result.errors[0].localized_message.contains("on hold"));
    }

    #[test]
    fn test_customer_used_when_no_b2b() {
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "amount": "100.00",
                        "currencyCode": "INR"
                    }
                },
                "buyerIdentity": {
                    "customer": {
                        "metafield": {
                            "jsonValue": {
                                "schemaVersion": 1,
                                "currencyCode": "INR",
                                "hold": true,
                                "holdReasonCode": "PAYMENT_OVERDUE",
                                "limitPaise": "10000000",
                                "exposurePaise": "0",
                                "updatedAt": "2026-10-23T00:00:00Z"
                            }
                        }
                    },
                    "purchasingCompany": null
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert_eq!(result.errors.len(), 1, "Customer metafield should be used when no B2B");
        assert!(result.errors[0].localized_message.contains("on hold"));
    }

    #[test]
    fn test_unknown_schema_version_passes() {
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "amount": "100.00",
                        "currencyCode": "INR"
                    }
                },
                "buyerIdentity": {
                    "customer": {
                        "metafield": {
                            "jsonValue": {
                                "schemaVersion": 999,
                                "currencyCode": "INR",
                                "hold": true,
                                "holdReasonCode": "PAYMENT_OVERDUE",
                                "limitPaise": "10000000",
                                "exposurePaise": "0",
                                "updatedAt": "2026-10-23T00:00:00Z"
                            }
                        }
                    },
                    "purchasingCompany": null
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.errors.is_empty(), "Unknown schema version should fail-open");
    }

    #[test]
    fn test_b2b_location_no_metafield_passes() {
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "amount": "100.00",
                        "currencyCode": "INR"
                    }
                },
                "buyerIdentity": {
                    "customer": {
                        "metafield": {
                            "jsonValue": {
                                "schemaVersion": 1,
                                "currencyCode": "INR",
                                "hold": true,
                                "holdReasonCode": "PAYMENT_OVERDUE",
                                "limitPaise": "10000000",
                                "exposurePaise": "0",
                                "updatedAt": "2026-10-23T00:00:00Z"
                            }
                        }
                    },
                    "purchasingCompany": {
                        "location": {
                            "metafield": null
                        }
                    }
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.errors.is_empty(), "B2B with no location metafield should pass (not a net-terms location)");
    }
}
