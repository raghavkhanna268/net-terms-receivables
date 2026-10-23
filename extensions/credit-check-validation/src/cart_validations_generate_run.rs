use crate::schema;
use shopify_function::prelude::*;
use shopify_function::scalars::JsonValue;
use shopify_function::Result;

const ERROR_MSG_ON_HOLD: &str = "Your account is currently on hold. Please contact us to resolve any outstanding issues before placing an order.";
const ERROR_MSG_OVER_LIMIT: &str = "This order would exceed your credit limit. Please contact us to discuss your account or make a payment on outstanding invoices.";

#[derive(Default, PartialEq, Clone, Debug)]
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

fn parse_decimal_to_paise(amount_str: &str) -> Option<u64> {
    let trimmed = amount_str.trim();
    if trimmed.is_empty() {
        return None;
    }

    let parts: Vec<&str> = trimmed.split('.').collect();
    match parts.len() {
        1 => {
            let whole: u64 = parts[0].parse().ok()?;
            whole.checked_mul(100)
        }
        2 => {
            let whole: u64 = parts[0].parse().ok()?;
            let frac_str = parts[1];
            
            if frac_str.len() > 2 {
                return None;
            }
            
            let frac_padded = if frac_str.len() == 1 {
                format!("{}0", frac_str)
            } else {
                frac_str.to_string()
            };
            
            let frac: u64 = frac_padded.parse().ok()?;
            
            let whole_paise = whole.checked_mul(100)?;
            whole_paise.checked_add(frac)
        }
        _ => None,
    }
}

fn create_validation_error(message: &str) -> schema::CartValidationsGenerateRunResult {
    let operation = schema::ValidationAddOperation {
        errors: vec![schema::ValidationError {
            message: message.to_string(),
            target: "$.cart".to_string(),
        }],
    };
    schema::CartValidationsGenerateRunResult {
        operations: vec![schema::Operation::ValidationAdd(operation)],
    }
}

fn pass() -> schema::CartValidationsGenerateRunResult {
    schema::CartValidationsGenerateRunResult { operations: vec![] }
}

fn evaluate_credit_status(
    credit_status: &CreditStatus,
    cart_currency: &str,
    cart_total_paise: u64,
) -> schema::CartValidationsGenerateRunResult {
    if credit_status.schema_version.is_none() {
        return pass();
    }
    let schema_version = credit_status.schema_version.unwrap();
    if schema_version != 1 {
        return pass();
    }

    if credit_status.hold == Some(true) {
        return create_validation_error(ERROR_MSG_ON_HOLD);
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
        return create_validation_error(ERROR_MSG_OVER_LIMIT);
    }

    pass()
}

#[shopify_function]
fn cart_validations_generate_run(input: schema::cart_validations_generate_run::Input) -> Result<schema::CartValidationsGenerateRunResult> {
    let step = input.buyer_journey().step();
    
    if let Some(s) = step {
        if s == "CART_INTERACTION" {
            return Ok(pass());
        }
    }

    let cart = input.cart();

    let cart_currency = cart.cost().total_amount().currency_code().to_string();
    let cart_total_amount_str = cart.cost().total_amount().amount().to_string();

    let cart_total_paise = match parse_decimal_to_paise(&cart_total_amount_str) {
        Some(v) => v,
        None => return Ok(pass()),
    };

    let buyer_identity = match cart.buyer_identity() {
        Some(bi) => bi,
        None => return Ok(pass()),
    };

    if let Some(purchasing_company) = buyer_identity.purchasing_company() {
        let location = purchasing_company.location();
        if let Some(metafield) = location.metafield() {
            let json_value = metafield.json_value();
            let credit_status = CreditStatus::from_json_value(json_value);
            return Ok(evaluate_credit_status(
                &credit_status,
                &cart_currency,
                cart_total_paise,
            ));
        }
        return Ok(pass());
    }

    if let Some(customer) = buyer_identity.customer() {
        if let Some(metafield) = customer.metafield() {
            let json_value = metafield.json_value();
            let credit_status = CreditStatus::from_json_value(json_value);
            return Ok(evaluate_credit_status(
                &credit_status,
                &cart_currency,
                cart_total_paise,
            ));
        }
    }

    Ok(pass())
}

#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::{run_function_with_input, Result};
    use serde_json::Value;

    const FIXTURES: &str = include_str!("../../../tests/fixtures/credit-status.json");

    fn run_test(input_json: &str) -> Result<schema::CartValidationsGenerateRunResult> {
        run_function_with_input(cart_validations_generate_run, input_json)
    }

    fn load_fixture(path: &str) -> String {
        let fixtures: Value = serde_json::from_str(FIXTURES).expect("Failed to parse fixtures JSON");
        let parts: Vec<&str> = path.split('.').collect();
        let mut current = &fixtures;
        for part in parts {
            current = &current[part];
        }
        serde_json::to_string(current).expect("Failed to serialize fixture")
    }

    fn make_input_with_step(cart_amount: &str, currency: &str, metafield_json: Option<&str>, has_b2b: bool, buyer_journey_step: Option<&str>) -> String {
        let customer_metafield = match metafield_json {
            Some(mf) if !has_b2b => format!(r#"{{ "jsonValue": {} }}"#, mf),
            _ => "null".to_string(),
        };

        let b2b_metafield = match metafield_json {
            Some(mf) if has_b2b => format!(r#"{{ "metafield": {{ "jsonValue": {} }} }}"#, mf),
            _ if has_b2b => r#"{ "metafield": null }"#.to_string(),
            _ => "null".to_string(),
        };

        let purchasing_company = if has_b2b {
            format!(r#"{{ "location": {} }}"#, b2b_metafield)
        } else {
            "null".to_string()
        };

        let step_value = match buyer_journey_step {
            Some(s) => format!(r#""{}""#, s),
            None => "null".to_string(),
        };

        format!(
            r#"{{
                "cart": {{
                    "cost": {{
                        "totalAmount": {{
                            "amount": "{}",
                            "currencyCode": "{}"
                        }}
                    }},
                    "buyerIdentity": {{
                        "customer": {{
                            "metafield": {}
                        }},
                        "purchasingCompany": {}
                    }}
                }},
                "buyerJourney": {{
                    "step": {}
                }}
            }}"#,
            cart_amount, currency, customer_metafield, purchasing_company, step_value
        )
    }

    fn make_input(cart_amount: &str, currency: &str, metafield_json: Option<&str>, has_b2b: bool, buyer_journey_step: &str) -> String {
        make_input_with_step(cart_amount, currency, metafield_json, has_b2b, Some(buyer_journey_step))
    }

    #[test]
    fn test_fixtures_valid_not_on_hold_passes() {
        let fixture = load_fixture("valid.notOnHold");
        let input = make_input("1000.00", "INR", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "valid.notOnHold should pass: under limit, not on hold");
    }

    #[test]
    fn test_fixtures_valid_on_hold_blocks() {
        let fixture = load_fixture("valid.onHold");
        let input = make_input("1000.00", "INR", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "valid.onHold should block");
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(op.errors[0].message.contains("on hold"));
            }
        }
    }

    #[test]
    fn test_fixtures_valid_at_limit_blocks() {
        let fixture = load_fixture("valid.atLimit");
        let input = make_input("100.00", "INR", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "valid.atLimit + any cart amount should exceed limit");
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(op.errors[0].message.contains("credit limit"));
            }
        }
    }

    #[test]
    fn test_fixtures_valid_usd_currency_with_matching_cart() {
        let fixture = load_fixture("valid.usdCurrency");
        let input = make_input("1000.00", "USD", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "USD fixture with USD cart should pass (under limit)");
    }

    #[test]
    fn test_fixtures_valid_usd_currency_mismatch_passes() {
        let fixture = load_fixture("valid.usdCurrency");
        let input = make_input("1000.00", "INR", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "USD fixture with INR cart should fail-open (currency mismatch)");
    }

    #[test]
    fn test_fixtures_invalid_wrong_schema_version_passes() {
        let fixture = load_fixture("invalid.wrongSchemaVersion");
        let input = make_input("100.00", "INR", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "invalid.wrongSchemaVersion should fail-open");
    }

    #[test]
    fn test_fixtures_invalid_missing_fields_passes() {
        let fixture = load_fixture("invalid.missingFields");
        let input = make_input("100.00", "INR", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "invalid.missingFields should fail-open");
    }

    #[test]
    fn test_fixtures_invalid_paise_passes() {
        let fixture = load_fixture("invalid.invalidPaise");
        let input = make_input("100.00", "INR", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "invalid.invalidPaise should fail-open");
    }

    #[test]
    fn test_fixtures_invalid_malformed_passes() {
        let fixture = load_fixture("invalid.malformed");
        let input = make_input("100.00", "INR", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "invalid.malformed should fail-open");
    }

    #[test]
    fn test_parse_decimal_to_paise_whole_number() {
        assert_eq!(parse_decimal_to_paise("100"), Some(10000));
        assert_eq!(parse_decimal_to_paise("1000"), Some(100000));
        assert_eq!(parse_decimal_to_paise("0"), Some(0));
    }

    #[test]
    fn test_parse_decimal_to_paise_with_cents() {
        assert_eq!(parse_decimal_to_paise("100.00"), Some(10000));
        assert_eq!(parse_decimal_to_paise("100.50"), Some(10050));
        assert_eq!(parse_decimal_to_paise("1000.5"), Some(100050));
        assert_eq!(parse_decimal_to_paise("1000.05"), Some(100005));
        assert_eq!(parse_decimal_to_paise("0.01"), Some(1));
        assert_eq!(parse_decimal_to_paise("0.99"), Some(99));
    }

    #[test]
    fn test_parse_decimal_to_paise_large_values() {
        assert_eq!(parse_decimal_to_paise("9999999999.99"), Some(999999999999));
        assert_eq!(parse_decimal_to_paise("1000000000"), Some(100000000000));
    }

    #[test]
    fn test_parse_decimal_to_paise_invalid() {
        assert_eq!(parse_decimal_to_paise(""), None);
        assert_eq!(parse_decimal_to_paise("abc"), None);
        assert_eq!(parse_decimal_to_paise("100.123"), None);
        assert_eq!(parse_decimal_to_paise("100.1.2"), None);
    }

    #[test]
    fn test_cart_interaction_passes() {
        let input = make_input("100.00", "INR", Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": true, "limitPaise": "10000000", "exposurePaise": "0"}"#), false, "CART_INTERACTION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "CART_INTERACTION should pass without validation");
    }

    #[test]
    fn test_null_step_validates() {
        let input = make_input_with_step(
            "100.00",
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": true, "holdReasonCode": "PAYMENT_OVERDUE", "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            None
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Null step (admin/draft-order checkout) should validate and block on hold");
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(op.errors[0].message.contains("on hold"));
            }
        }
    }

    #[test]
    fn test_no_metafield_passes() {
        let input = make_input("100.00", "INR", None, false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "No metafield should pass");
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
            },
            "buyerJourney": {
                "step": "CHECKOUT_COMPLETION"
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.operations.is_empty(), "Guest checkout should pass");
    }

    #[test]
    fn test_hold_blocks() {
        let input = make_input(
            "100.00",
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": true, "holdReasonCode": "PAYMENT_OVERDUE", "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            "CHECKOUT_COMPLETION"
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Hold should block");
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(op.errors[0].message.contains("on hold"));
            }
        }
    }

    #[test]
    fn test_under_limit_passes() {
        let input = make_input(
            "1000.00",
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            "CHECKOUT_COMPLETION"
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Under limit should pass");
    }

    #[test]
    fn test_over_limit_blocks() {
        let input = make_input(
            "60000.00",
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            "CHECKOUT_COMPLETION"
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Over limit should block");
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(op.errors[0].message.contains("credit limit"));
            }
        }
    }

    #[test]
    fn test_exactly_at_limit_passes() {
        let input = make_input(
            "50000.00",
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            "CHECKOUT_COMPLETION"
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Exactly at limit should pass");
    }

    #[test]
    fn test_currency_mismatch_passes() {
        let input = make_input(
            "60000.00",
            "USD",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            "CHECKOUT_COMPLETION"
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Currency mismatch should pass (fail-open)");
    }

    #[test]
    fn test_malformed_json_passes() {
        let input = make_input(
            "100.00",
            "INR",
            Some(r#"{"notARealField": "garbage"}"#),
            false,
            "CHECKOUT_COMPLETION"
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Malformed JSON should pass (fail-open)");
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
            },
            "buyerJourney": {
                "step": "CHECKOUT_COMPLETION"
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert_eq!(result.operations.len(), 1, "B2B location metafield should take precedence (hold=true)");
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(op.errors[0].message.contains("on hold"));
            }
        }
    }

    #[test]
    fn test_customer_used_when_no_b2b() {
        let input = make_input(
            "100.00",
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": true, "holdReasonCode": "PAYMENT_OVERDUE", "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            "CHECKOUT_COMPLETION"
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Customer metafield should be used when no B2B");
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(op.errors[0].message.contains("on hold"));
            }
        }
    }

    #[test]
    fn test_unknown_schema_version_passes() {
        let input = make_input(
            "100.00",
            "INR",
            Some(r#"{"schemaVersion": 999, "currencyCode": "INR", "hold": true, "holdReasonCode": "PAYMENT_OVERDUE", "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            "CHECKOUT_COMPLETION"
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Unknown schema version should fail-open");
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
            },
            "buyerJourney": {
                "step": "CHECKOUT_COMPLETION"
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.operations.is_empty(), "B2B with no location metafield should pass (not a net-terms location)");
    }
}
