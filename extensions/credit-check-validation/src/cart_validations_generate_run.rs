use crate::schema;
use shopify_function::prelude::*;
use shopify_function::scalars::JsonValue;
use shopify_function::Result;

const ERROR_MSG_ON_HOLD: &str = "Your account is currently on hold. Please contact us to resolve any outstanding issues before placing an order.";
const ERROR_MSG_OVER_LIMIT: &str = "This order would exceed your credit limit. Please contact us to discuss your account or make a payment on outstanding invoices.";

/// #292: The only supported shop currency in v1.
const SUPPORTED_SHOP_CURRENCY: &str = "INR";

/// #292: Shop config from the $app:shop_config metafield.
/// Written by after-auth and read by functions to determine shop currency.
#[derive(Default, PartialEq, Clone, Debug)]
pub struct ShopConfig {
    pub schema_version: Option<i32>,
    pub currency_code: Option<String>,
}

impl ShopConfig {
    fn from_json_value(json_value: &JsonValue) -> Self {
        if let JsonValue::Object(obj) = json_value {
            ShopConfig {
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
            }
        } else {
            ShopConfig::default()
        }
    }

    /// #292: Check if the shop is an INR shop.
    /// Returns Some(true) if shop_config has INR currency, Some(false) if non-INR.
    /// Returns None if shop_config is missing/invalid (caller decides fail-open vs fail-closed).
    fn is_inr_shop(&self) -> Option<bool> {
        self.currency_code.as_ref().map(|c| c == SUPPORTED_SHOP_CURRENCY)
    }
}

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

/// #292: Evaluate credit status with INR-only logic.
///
/// Decision table (per rulings):
/// 1. HELD → block (before any other check)
/// 2. schemaVersion missing or != 1 → pass (fail-open)
/// 3. Non-INR shop (shop_config.currencyCode != "INR") → pass (non-held buyers never blocked)
/// 4. INR shop with non-INR cart → pass (hide-terms handles it, no blocking)
/// 5. Over-limit → block
/// 6. Otherwise → pass
fn evaluate_credit_status(
    credit_status: &CreditStatus,
    cart_currency: &str,
    cart_total_paise: u64,
    shop_config: &ShopConfig,
) -> schema::CartValidationsGenerateRunResult {
    // #292: HELD check comes FIRST, before schemaVersion
    if credit_status.hold == Some(true) {
        return create_validation_error(ERROR_MSG_ON_HOLD);
    }

    // schemaVersion gate (unchanged from original)
    if credit_status.schema_version.is_none() {
        return pass();
    }
    let schema_version = credit_status.schema_version.unwrap();
    if schema_version != 1 {
        return pass();
    }

    // #292: Non-INR shop → pass (non-held buyers never blocked in non-INR shop)
    // Missing shop_config: continue checking (fail-closed, not fail-open)
    if let Some(is_inr) = shop_config.is_inr_shop() {
        if !is_inr {
            return pass();
        }
    }

    let status_currency = match &credit_status.currency_code {
        Some(c) => c.as_str(),
        None => return pass(),
    };

    // #292: INR shop with non-INR cart → pass (hide-terms handles it)
    // Changed from the original fail-open to explicit pass with different intent
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

    // #292: Read shop_config for INR-only logic
    let shop_config = match input.shop().metafield() {
        Some(m) => ShopConfig::from_json_value(m.json_value()),
        None => ShopConfig::default(),
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
                &shop_config,
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
                &shop_config,
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

    /// #292: Helper to create test input with shop_config
    fn make_input_with_step_and_shop_config(
        cart_amount: &str,
        currency: &str,
        metafield_json: Option<&str>,
        has_b2b: bool,
        buyer_journey_step: Option<&str>,
        shop_config_json: Option<&str>,
    ) -> String {
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

        let shop_metafield = match shop_config_json {
            Some(cfg) => format!(r#"{{ "jsonValue": {} }}"#, cfg),
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
                }},
                "shop": {{
                    "metafield": {}
                }}
            }}"#,
            cart_amount, currency, customer_metafield, purchasing_company, step_value, shop_metafield
        )
    }

    fn make_input_with_step(cart_amount: &str, currency: &str, metafield_json: Option<&str>, has_b2b: bool, buyer_journey_step: Option<&str>) -> String {
        // #292: Default to INR shop config for backward compatibility
        make_input_with_step_and_shop_config(
            cart_amount,
            currency,
            metafield_json,
            has_b2b,
            buyer_journey_step,
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR"}"#),
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
    fn test_fixtures_invalid_wrong_schema_version_held_blocks() {
        // #292: HELD check runs FIRST, before schemaVersion - held buyer is always blocked
        let fixture = load_fixture("invalid.wrongSchemaVersion");
        let input = make_input("100.00", "INR", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "invalid.wrongSchemaVersion (held=true) should BLOCK due to HELD-first");
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(op.errors[0].message.contains("on hold"));
            }
        }
    }

    #[test]
    fn test_fixtures_invalid_wrong_schema_version_not_held_passes() {
        // Non-held buyer with wrong schemaVersion should fail-open (pass)
        let fixture = load_fixture("invalid.wrongSchemaVersionNotHeld");
        let input = make_input("100.00", "INR", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "invalid.wrongSchemaVersionNotHeld should fail-open");
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
            },
            "shop": {
                "metafield": {
                    "jsonValue": {"schemaVersion": 1, "currencyCode": "INR"}
                }
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

    /// #292: Non-INR shop with over-limit buyer should NOT block (net-terms not enforced)
    /// This test verifies the validation function does NOT fail-open incorrectly:
    /// - shop_config.currencyCode = "EUR" (non-INR shop)
    /// - Buyer has a limit that would be exceeded (limit=10000000, exposure=5000000, cart=60000.00)
    /// - Checkout should PASS because non-INR shop = no net-terms enforcement
    #[test]
    fn test_non_inr_shop_over_limit_passes() {
        let input = make_input_with_step_and_shop_config(
            "60000.00",  // 6000000 paise - would exceed limit if enforced
            "EUR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "EUR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            Some("CHECKOUT_COMPLETION"),
            Some(r#"{"schemaVersion": 1, "currencyCode": "EUR"}"#),
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Non-INR shop should NOT block over-limit buyer (net-terms not enforced)");
    }

    /// #292: Missing shop_config must NOT fail-open - over-limit buyer should be blocked.
    /// When shop_config is missing, we cannot determine if the shop is INR or not,
    /// so we conservatively continue checking credit limits.
    #[test]
    fn test_missing_shop_config_over_limit_blocks() {
        let input = make_input_with_step_and_shop_config(
            "60000.00",  // 6000000 paise - would exceed limit if enforced
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            Some("CHECKOUT_COMPLETION"),
            None,  // Missing shop_config - should NOT fail-open
        );
        let result = run_test(&input).unwrap();
        assert!(!result.operations.is_empty(), "Missing shop_config must NOT fail-open - over-limit buyer should be blocked");
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
            },
            "shop": {
                "metafield": {
                    "jsonValue": {"schemaVersion": 1, "currencyCode": "INR"}
                }
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
    fn test_unknown_schema_version_not_held_passes() {
        // #292: Non-held buyer with unknown schemaVersion should fail-open (pass)
        let input = make_input(
            "100.00",
            "INR",
            Some(r#"{"schemaVersion": 999, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            "CHECKOUT_COMPLETION"
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Unknown schema version (not held) should fail-open");
    }

    #[test]
    fn test_unknown_schema_version_held_blocks() {
        // #292: HELD check runs FIRST - held buyer with unknown schemaVersion should BLOCK
        let input = make_input(
            "100.00",
            "INR",
            Some(r#"{"schemaVersion": 999, "currencyCode": "INR", "hold": true, "holdReasonCode": "PAYMENT_OVERDUE", "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            "CHECKOUT_COMPLETION"
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Unknown schema version (held=true) should BLOCK due to HELD-first");
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(op.errors[0].message.contains("on hold"));
            }
        }
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
            },
            "shop": {
                "metafield": {
                    "jsonValue": {"schemaVersion": 1, "currencyCode": "INR"}
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.operations.is_empty(), "B2B with no location metafield should pass (not a net-terms location)");
    }

    // =========================================================================
    // Missing/Null $app:credit_status metafield = ALLOW (fail-open)
    // These tests verify that seed CompanyLocations without the metafield
    // are allowed through checkout (no validation error, nothing hidden).
    // =========================================================================

    #[test]
    fn test_missing_credit_status_metafield_allows_checkout() {
        // When $app:credit_status is missing (null), checkout should ALLOW.
        // This is the fail-open behavior required for seed CompanyLocations
        // that haven't had their metafield synced yet.
        let input = make_input("100.00", "INR", None, false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Missing credit_status metafield must ALLOW (no validation error)");
    }

    #[test]
    fn test_b2b_missing_credit_status_metafield_allows_checkout() {
        // B2B CompanyLocation with null $app:credit_status should ALLOW.
        let input = make_b2b_input(None, &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "B2B with missing credit_status metafield must ALLOW");
    }

    #[test]
    fn test_null_json_value_in_metafield_allows_checkout() {
        // Even if the metafield object exists but jsonValue is empty/null-like
        let input = make_input("100.00", "INR", Some("null"), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Null jsonValue in metafield must ALLOW");
    }

    #[test]
    fn test_empty_object_metafield_allows_checkout() {
        // Empty object {} should fail-open (no schemaVersion)
        let input = make_input("100.00", "INR", Some("{}"), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Empty object metafield must ALLOW (fail-open)");
    }

    /// #292: Both credit_status AND shop_config missing must ALLOW (fail-open).
    /// This is the scenario for brand-new CompanyLocations before any metafield sync.
    #[test]
    fn test_missing_credit_status_and_missing_shop_config_allows_checkout() {
        let input = make_input_with_step_and_shop_config(
            "100.00",
            "INR",
            None,  // No credit_status metafield
            false,
            Some("CHECKOUT_COMPLETION"),
            None,  // No shop_config metafield
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Missing credit_status AND missing shop_config must ALLOW (fail-open)");
    }

    /// #292: B2B location with both metafields missing must ALLOW.
    #[test]
    fn test_b2b_missing_credit_status_and_missing_shop_config_allows_checkout() {
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
                    "customer": null,
                    "purchasingCompany": {
                        "location": {
                            "metafield": null
                        }
                    }
                }
            },
            "buyerJourney": {
                "step": "CHECKOUT_COMPLETION"
            },
            "shop": {
                "metafield": null
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.operations.is_empty(), "B2B with missing credit_status AND missing shop_config must ALLOW");
    }

    fn make_b2b_input(metafield_json: Option<&str>, _payment_methods: &[(&str, &str)]) -> String {
        let location_metafield = match metafield_json {
            Some(mf) => format!(r#"{{ "jsonValue": {} }}"#, mf),
            None => "null".to_string(),
        };

        format!(
            r#"{{
                "cart": {{
                    "cost": {{
                        "totalAmount": {{
                            "amount": "100.00",
                            "currencyCode": "INR"
                        }}
                    }},
                    "buyerIdentity": {{
                        "customer": null,
                        "purchasingCompany": {{
                            "location": {{
                                "metafield": {}
                            }}
                        }}
                    }}
                }},
                "buyerJourney": {{
                    "step": "CHECKOUT_COMPLETION"
                }},
                "shop": {{
                    "metafield": {{
                        "jsonValue": {{"schemaVersion": 1, "currencyCode": "INR"}}
                    }}
                }}
            }}"#,
            location_metafield
        )
    }

    fn default_payment_methods() -> Vec<(&'static str, &'static str)> {
        vec![
            ("gid://shopify/PaymentCustomizationPaymentMethod/1", "Credit Card"),
            ("gid://shopify/PaymentCustomizationPaymentMethod/2", "Deferred Payment"),
        ]
    }

    // S11 compatibility tests: verify the JS writer produces JSON that Rust can deserialize
    // These tests use the same fixtures as the TypeScript tests in app/lib/__tests__/metafields-contract.test.ts

    #[test]
    fn test_s11_js_writer_format_with_all_hold_reason_codes() {
        // Test all holdReasonCode values that S11 may write
        let hold_reasons = vec![
            "MANUAL_HOLD",
            "PAYMENT_OVERDUE",
            "CREDIT_REVIEW",
            "NEW_ACCOUNT",
            "FRAUD_SUSPECTED",
        ];

        for reason in hold_reasons {
            let metafield = format!(
                r#"{{"schemaVersion": 1, "currencyCode": "INR", "hold": true, "holdReasonCode": "{}", "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T15:42:00.000Z"}}"#,
                reason
            );
            let input = make_input("100.00", "INR", Some(&metafield), false, "CHECKOUT_COMPLETION");
            let result = run_test(&input).unwrap();
            assert_eq!(
                result.operations.len(),
                1,
                "S11 holdReasonCode '{}' should be recognized and hold should block",
                reason
            );
        }
    }

    #[test]
    fn test_s11_js_writer_no_limit_format() {
        // S11 writes "999999999999999" for no limit (very large value)
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "999999999999999", "exposurePaise": "5000000", "updatedAt": "2026-10-23T15:42:00.000Z"}"#;
        let input = make_input("1000000.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "S11 'no limit' (999999999999999) should allow large carts");
    }

    #[test]
    fn test_s11_js_writer_iso_timestamp_format() {
        // S11 writes ISO 8601 timestamps with milliseconds
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T15:42:00.123Z"}"#;
        let input = make_input("1000.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "S11 ISO timestamp with milliseconds should parse correctly");
    }

    #[test]
    fn test_s11_shared_fixture_roundtrip() {
        // Verify all valid fixtures from tests/fixtures/credit-status.json can be deserialized
        // and produce expected results. This proves JS and Rust use the same schema.
        
        // valid.notOnHold: hold=false, under limit
        let fixture = load_fixture("valid.notOnHold");
        let input = make_input("1000.00", "INR", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Shared fixture notOnHold should pass");

        // valid.onHold: hold=true
        let fixture = load_fixture("valid.onHold");
        let input = make_input("0.00", "INR", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Shared fixture onHold should block");

        // valid.atLimit: exposure equals limit
        let fixture = load_fixture("valid.atLimit");
        let input = make_input("0.01", "INR", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Shared fixture atLimit should block on any cart");

        // valid.usdCurrency: USD currency
        let fixture = load_fixture("valid.usdCurrency");
        let input = make_input("1000.00", "USD", Some(&fixture), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Shared fixture usdCurrency should pass for USD cart under limit");
    }

    // =========================================================================
    // #292 G2: Malformed shop_config tests (fail-closed for over-limit)
    // =========================================================================

    #[test]
    fn test_malformed_shop_config_held_buyer_still_blocks() {
        // #292 G2: A HELD buyer is still blocked even with malformed shop_config
        let input = make_input_with_step_and_shop_config(
            "100.00",
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": true, "holdReasonCode": "MANUAL_HOLD", "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            Some("CHECKOUT_COMPLETION"),
            Some(r#"{"notValid": true}"#),  // Malformed shop_config
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "HELD buyer must be blocked even with malformed shop_config");
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(op.errors[0].message.contains("on hold"));
            }
        }
    }

    #[test]
    fn test_malformed_shop_config_over_limit_fails_closed() {
        // #292 G2: Over-limit buyer fails closed even with malformed shop_config
        let input = make_input_with_step_and_shop_config(
            "60000.00",  // 6000000 paise - would exceed limit
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            Some("CHECKOUT_COMPLETION"),
            Some(r#"{"notValid": true}"#),  // Malformed shop_config
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Over-limit buyer must be blocked even with malformed shop_config (fail-closed)");
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(op.errors[0].message.contains("credit limit"));
            }
        }
    }

    #[test]
    fn test_malformed_shop_config_no_credit_status_passes() {
        // #292 G2: Ordinary cart with no credit_status and malformed shop_config passes
        let input = make_input_with_step_and_shop_config(
            "100.00",
            "INR",
            None,  // No credit_status
            false,
            Some("CHECKOUT_COMPLETION"),
            Some(r#"{"notValid": true}"#),  // Malformed shop_config
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Ordinary cart with no credit_status should pass even with malformed shop_config");
    }

    #[test]
    fn test_malformed_shop_config_wrong_schema_version_over_limit_blocks() {
        // #292 G2: Over-limit buyer with wrong schemaVersion in shop_config fails closed
        let input = make_input_with_step_and_shop_config(
            "60000.00",
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            Some("CHECKOUT_COMPLETION"),
            Some(r#"{"schemaVersion": 999, "currencyCode": "INR"}"#),  // Wrong schemaVersion
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Over-limit with wrong schemaVersion shop_config must block (fail-closed)");
    }

    #[test]
    fn test_malformed_shop_config_missing_currency_code_over_limit_blocks() {
        // #292 G2: Over-limit buyer with missing currencyCode in shop_config fails closed
        let input = make_input_with_step_and_shop_config(
            "60000.00",
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            Some("CHECKOUT_COMPLETION"),
            Some(r#"{"schemaVersion": 1}"#),  // Missing currencyCode
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Over-limit with missing currencyCode shop_config must block (fail-closed)");
    }

    // =========================================================================
    // Case 2: Credit-limit boundary math tests
    // Tests exactly-at-limit, one paisa over, and multiple invoices summed
    // =========================================================================

    fn make_validation_input_runtime(
        cart_amount: &str,
        currency: &str,
        limit_paise: &str,
        exposure_paise: &str,
        hold: bool,
        has_b2b: bool,
    ) -> String {
        let metafield = format!(
            r#"{{"schemaVersion": 1, "currencyCode": "{}", "hold": {}, "holdReasonCode": null, "limitPaise": "{}", "exposurePaise": "{}", "updatedAt": "2026-10-23T00:00:00Z"}}"#,
            currency, hold, limit_paise, exposure_paise
        );

        let buyer_identity = if has_b2b {
            format!(
                r#"{{ "customer": null, "purchasingCompany": {{ "location": {{ "metafield": {{ "jsonValue": {} }} }} }} }}"#,
                metafield
            )
        } else {
            format!(
                r#"{{ "customer": {{ "metafield": {{ "jsonValue": {} }} }}, "purchasingCompany": null }}"#,
                metafield
            )
        };

        format!(
            r#"{{
                "cart": {{
                    "cost": {{ "totalAmount": {{ "amount": "{}", "currencyCode": "{}" }} }},
                    "buyerIdentity": {}
                }},
                "buyerJourney": {{ "step": "CHECKOUT_COMPLETION" }},
                "shop": {{ "metafield": {{ "jsonValue": {{"schemaVersion": 1, "currencyCode": "{}"}} }} }}
            }}"#,
            cart_amount, currency, buyer_identity, currency
        )
    }

    #[test]
    fn test_exactly_at_limit_passes_checkout() {
        // limit = 100000.00 INR (10000000 paise), exposure = 50000.00 INR (5000000 paise)
        // cart = 50000.00 INR (5000000 paise)
        // total_exposure = 5000000 + 5000000 = 10000000 paise = limit
        // Result: PASS (not over)
        let input = make_validation_input_runtime(
            "50000.00",  // cart amount
            "INR",
            "10000000",  // limit 100000.00 INR in paise
            "5000000",   // existing exposure 50000.00 INR in paise
            false,       // not held
            true,        // B2B
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Exactly at limit (total_exposure == limit) should PASS");
    }

    #[test]
    fn test_one_paisa_over_limit_blocks() {
        // limit = 100000.00 INR (10000000 paise), exposure = 50000.00 INR (5000000 paise)
        // cart = 50000.01 INR (5000001 paise)
        // total_exposure = 5000000 + 5000001 = 10000001 paise > limit
        // Result: BLOCK
        let input = make_validation_input_runtime(
            "50000.01",  // cart amount - one paisa over
            "INR",
            "10000000",  // limit 100000.00 INR in paise
            "5000000",   // existing exposure 50000.00 INR in paise
            false,       // not held
            true,        // B2B
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "One paisa over limit should BLOCK");
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(op.errors[0].message.contains("credit limit"), "Error message should mention credit limit");
            }
        }
    }

    #[test]
    fn test_small_cart_with_high_exposure_blocks() {
        // limit = 100000.00 INR, exposure = 99999.50 INR
        // cart = 1.00 INR (100 paise)
        // total_exposure = 9999950 + 100 = 10000050 paise > 10000000 limit
        // Result: BLOCK
        let input = make_validation_input_runtime(
            "1.00",      // small cart
            "INR",
            "10000000",  // limit
            "9999950",   // high exposure (99999.50 INR)
            false,
            true,
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Small cart pushing over limit should BLOCK");
    }

    #[test]
    fn test_exposure_already_at_limit_any_cart_blocks() {
        // limit = exposure = 10000000 paise (100000.00 INR)
        // Any cart amount > 0 should block
        let input = make_validation_input_runtime(
            "0.01",      // minimal cart
            "INR",
            "10000000",
            "10000000",  // exposure already at limit
            false,
            true,
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Exposure at limit + any cart should BLOCK");
    }

    #[test]
    fn test_exposure_over_limit_but_not_held_still_blocks() {
        // Simulates when exposure exceeded limit but hold wasn't set yet
        // limit = 10000000, exposure = 11000000 (already over)
        // hold = false (sync hasn't run yet)
        // Should still block based on math
        let input = make_validation_input_runtime(
            "0.01",
            "INR",
            "10000000",  // 100000 INR limit
            "11000000",  // 110000 INR exposure (already over)
            false,       // not marked as held
            true,
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Over-limit exposure should block even if not marked held");
    }

    #[test]
    fn test_multiple_invoices_summed_correctly() {
        // This test simulates the sum of multiple invoices via the exposure field
        // exposure = 2500000 + 3500000 + 1500000 = 7500000 paise (75000 INR)
        // limit = 10000000 paise (100000 INR)
        // cart = 30000.00 INR (3000000 paise)
        // total = 7500000 + 3000000 = 10500000 > 10000000
        // Result: BLOCK
        let input = make_validation_input_runtime(
            "30000.00",  // cart
            "INR",
            "10000000",  // limit
            "7500000",   // sum of multiple invoices
            false,
            true,
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Sum of multiple invoices + cart over limit should BLOCK");
    }

    #[test]
    fn test_multiple_invoices_under_limit_passes() {
        // exposure = 7000000 paise (70000 INR from multiple invoices)
        // limit = 10000000 paise (100000 INR)
        // cart = 25000.00 INR (2500000 paise)
        // total = 7000000 + 2500000 = 9500000 < 10000000
        // Result: PASS
        let input = make_validation_input_runtime(
            "25000.00",
            "INR",
            "10000000",
            "7000000",
            false,
            true,
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Sum of invoices + cart under limit should PASS");
    }

    #[test]
    fn test_zero_limit_any_cart_blocks() {
        // Edge case: limit = 0 means no credit allowed
        let input = make_validation_input_runtime(
            "100.00",
            "INR",
            "0",  // zero limit
            "0",
            false,
            true,
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Zero limit should block any cart");
    }

    #[test]
    fn test_tagged_customer_exactly_at_limit_passes() {
        // Same boundary test for tagged customer path
        let input = make_validation_input_runtime(
            "50000.00",
            "INR",
            "10000000",
            "5000000",
            false,
            false,  // tagged customer, not B2B
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Tagged customer exactly at limit should PASS");
    }

    #[test]
    fn test_tagged_customer_one_paisa_over_blocks() {
        let input = make_validation_input_runtime(
            "50000.01",
            "INR",
            "10000000",
            "5000000",
            false,
            false,  // tagged customer
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Tagged customer one paisa over should BLOCK");
    }

    // =========================================================================
    // Case 5: Non-INR shop fail-closed for validation
    // =========================================================================

    fn make_validation_input_with_shop_currency(
        cart_amount: &str,
        cart_currency: &str,
        shop_currency: &str,
        metafield_currency: &str,
        limit_paise: &str,
        exposure_paise: &str,
    ) -> String {
        let metafield = format!(
            r#"{{"schemaVersion": 1, "currencyCode": "{}", "hold": false, "holdReasonCode": null, "limitPaise": "{}", "exposurePaise": "{}", "updatedAt": "2026-10-23T00:00:00Z"}}"#,
            metafield_currency, limit_paise, exposure_paise
        );

        let shop_config = format!(r#"{{"schemaVersion": 1, "currencyCode": "{}"}}"#, shop_currency);

        format!(
            r#"{{
                "cart": {{
                    "cost": {{ "totalAmount": {{ "amount": "{}", "currencyCode": "{}" }} }},
                    "buyerIdentity": {{
                        "customer": null,
                        "purchasingCompany": {{ "location": {{ "metafield": {{ "jsonValue": {} }} }} }}
                    }}
                }},
                "buyerJourney": {{ "step": "CHECKOUT_COMPLETION" }},
                "shop": {{ "metafield": {{ "jsonValue": {} }} }}
            }}"#,
            cart_amount, cart_currency, metafield, shop_config
        )
    }

    #[test]
    fn test_non_inr_shop_validation_passes() {
        // Non-INR shop: validation passes (hide-terms handles it, no blocking)
        // Even with over-limit exposure
        let input = make_validation_input_with_shop_currency(
            "60000.00",  // would be over limit
            "USD",       // cart currency
            "USD",       // shop currency
            "USD",       // metafield currency
            "10000000",
            "5000000",
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Non-INR shop validation should pass (hide-terms handles restriction)");
    }

    #[test]
    fn test_inr_shop_with_currency_mismatch_passes() {
        // INR shop with non-INR cart: validation passes (currency mismatch)
        // Metafield is INR (buyer's credit status currency), cart is USD
        let input = make_validation_input_with_shop_currency(
            "60000.00",
            "USD",  // cart in USD
            "INR",  // shop is INR
            "INR",  // metafield is INR (buyer's credit currency)
            "10000000",
            "5000000",
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "INR shop with currency mismatch should pass");
    }

    // =========================================================================
    // Cross-Language Contract Fixtures (generated by TS metafield writers)
    // These fixtures are generated by app/lib/__tests__/metafield-function-fixtures.test.ts
    // and verify the Rust Function correctly interprets the TypeScript writer output.
    // =========================================================================

    #[test]
    fn fixture_unheld_under_limit() {
        let input = include_str!("../tests/fixtures/fixture_unheld_under_limit.json");
        let result = run_test(input).unwrap();
        assert!(
            result.operations.is_empty(),
            "fixture_unheld_under_limit: unheld buyer under the credit limit should ALLOW"
        );
    }

    #[test]
    fn fixture_unheld_over_limit() {
        let input = include_str!("../tests/fixtures/fixture_unheld_over_limit.json");
        let result = run_test(input).unwrap();
        assert_eq!(
            result.operations.len(),
            1,
            "fixture_unheld_over_limit: unheld buyer over the credit limit should BLOCK"
        );
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(
                    op.errors[0].message.contains("credit limit"),
                    "fixture_unheld_over_limit: error message should mention credit limit"
                );
            }
        }
    }

    #[test]
    fn fixture_held() {
        let input = include_str!("../tests/fixtures/fixture_held.json");
        let result = run_test(input).unwrap();
        assert_eq!(
            result.operations.len(),
            1,
            "fixture_held: buyer on manual hold should BLOCK"
        );
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(
                    op.errors[0].message.contains("on hold"),
                    "fixture_held: error message should mention on hold"
                );
            }
        }
    }

    #[test]
    fn fixture_zero_limit() {
        let input = include_str!("../tests/fixtures/fixture_zero_limit.json");
        let result = run_test(input).unwrap();
        assert_eq!(
            result.operations.len(),
            1,
            "fixture_zero_limit: buyer with zero credit limit should BLOCK any cart"
        );
        match &result.operations[0] {
            schema::Operation::ValidationAdd(op) => {
                assert!(
                    op.errors[0].message.contains("credit limit"),
                    "fixture_zero_limit: error message should mention credit limit"
                );
            }
        }
    }

    #[test]
    fn fixture_no_limit() {
        let input = include_str!("../tests/fixtures/fixture_no_limit.json");
        let result = run_test(input).unwrap();
        assert!(
            result.operations.is_empty(),
            "fixture_no_limit: buyer with no limit set (unlimited credit) should ALLOW"
        );
    }

    // =========================================================================
    // Edge-Case Tests: Metafield parsing and type coercion
    // =========================================================================

    /// Empty string metafield (not a JSON object).
    #[test]
    fn test_metafield_empty_string() {
        let input = make_input("100.00", "INR", Some(r#""""#), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: metafield empty string");
    }

    /// Array metafield (not a JSON object).
    #[test]
    fn test_metafield_array() {
        let input = make_input("100.00", "INR", Some(r#"[1, 2, 3]"#), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: metafield array");
    }

    /// Number metafield (not a JSON object).
    #[test]
    fn test_metafield_number() {
        let input = make_input("100.00", "INR", Some(r#"12345"#), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: metafield number");
    }

    /// Boolean metafield (not a JSON object).
    #[test]
    fn test_metafield_boolean() {
        let input = make_input("100.00", "INR", Some(r#"true"#), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: metafield boolean");
    }

    /// hold field as string "true" instead of boolean, under limit.
    #[test]
    fn test_hold_string_true_under_limit() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": "true", "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: hold as string true, under limit");
    }

    /// hold field as string "HOLD", under limit.
    #[test]
    fn test_hold_string_hold_under_limit() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": "HOLD", "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: hold as string HOLD, under limit");
    }

    /// hold field as empty string, under limit.
    #[test]
    fn test_hold_empty_string_under_limit() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": "", "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: hold as empty string, under limit");
    }

    /// hold field as number 1, under limit.
    #[test]
    fn test_hold_number_under_limit() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": 1, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: hold as number, under limit");
    }

    /// schemaVersion field as string "1" with hold=true.
    #[test]
    fn test_schema_version_string_with_hold_true() {
        let metafield = r#"{"schemaVersion": "1", "currencyCode": "INR", "hold": true, "holdReasonCode": "MANUAL_HOLD", "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "pinned behaviour: schemaVersion string with hold true");
    }

    /// schemaVersion field as string "1", not held, under limit.
    #[test]
    fn test_schema_version_string_not_held() {
        let metafield = r#"{"schemaVersion": "1", "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: schemaVersion string, not held");
    }

    /// schemaVersion as 0 with hold=true.
    #[test]
    fn test_schema_version_zero_with_hold_true() {
        let metafield = r#"{"schemaVersion": 0, "currencyCode": "INR", "hold": true, "holdReasonCode": "MANUAL_HOLD", "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "pinned behaviour: schemaVersion zero with hold true");
    }

    /// schemaVersion as 0, not held, under limit.
    #[test]
    fn test_schema_version_zero_not_held() {
        let metafield = r#"{"schemaVersion": 0, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: schemaVersion zero, not held");
    }

    /// schemaVersion as -1, not held, under limit.
    #[test]
    fn test_schema_version_negative_not_held() {
        let metafield = r#"{"schemaVersion": -1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: schemaVersion negative, not held");
    }

    /// currencyCode field missing, under limit.
    #[test]
    fn test_currency_code_missing_under_limit() {
        let metafield = r#"{"schemaVersion": 1, "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: currencyCode missing, under limit");
    }

    /// currencyCode as number, under limit.
    #[test]
    fn test_currency_code_number_under_limit() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": 356, "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: currencyCode as number, under limit");
    }

    /// limitPaise as empty string.
    #[test]
    fn test_limit_paise_empty_string() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("60000.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: limitPaise empty string");
    }

    /// limitPaise as number instead of string.
    #[test]
    fn test_limit_paise_number() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": 10000000, "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("60000.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: limitPaise as number");
    }

    /// limitPaise as non-numeric string "abc".
    #[test]
    fn test_limit_paise_non_numeric() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "abc", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("60000.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: limitPaise non-numeric");
    }

    /// exposurePaise as empty string.
    #[test]
    fn test_exposure_paise_empty_string() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("60000.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: exposurePaise empty string");
    }

    /// exposurePaise as number instead of string.
    #[test]
    fn test_exposure_paise_number() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": 5000000, "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("60000.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: exposurePaise as number");
    }

    /// exposurePaise as non-numeric string "abc".
    #[test]
    fn test_exposure_paise_non_numeric() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "abc", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("60000.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: exposurePaise non-numeric");
    }

    // =========================================================================
    // Edge-Case Tests: Boundary amounts
    // =========================================================================

    /// Negative limitPaise string (parse_paise only accepts unsigned integers).
    #[test]
    fn test_limit_paise_negative() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "-10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: limitPaise negative");
    }

    /// Negative exposurePaise string.
    #[test]
    fn test_exposure_paise_negative() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "-5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: exposurePaise negative");
    }

    /// Very large limitPaise (near u64 max).
    #[test]
    fn test_limit_paise_very_large() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "18446744073709551615", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("100.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: limitPaise very large");
    }

    /// Zero exposure, zero limit, cart > 0.
    #[test]
    fn test_zero_exposure_zero_limit_with_cart() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "0", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("0.01", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "pinned behaviour: zero limit with cart");
    }

    /// Zero cart, zero exposure, zero limit.
    #[test]
    fn test_zero_cart_zero_exposure_zero_limit() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "0", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_input("0.00", "INR", Some(metafield), false, "CHECKOUT_COMPLETION");
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: zero cart, zero limit");
    }

    // =========================================================================
    // Edge-Case Tests: shop_config parsing
    // =========================================================================

    /// Empty string shop_config with held buyer.
    #[test]
    fn test_empty_string_shop_config_held_buyer() {
        let input = r#"
        {
            "cart": {
                "cost": { "totalAmount": { "amount": "100.00", "currencyCode": "INR" } },
                "buyerIdentity": {
                    "customer": { "metafield": { "jsonValue": {"schemaVersion": 1, "currencyCode": "INR", "hold": true, "holdReasonCode": "MANUAL_HOLD", "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"} } },
                    "purchasingCompany": null
                }
            },
            "buyerJourney": { "step": "CHECKOUT_COMPLETION" },
            "shop": { "metafield": { "jsonValue": "" } }
        }
        "#;
        let result = run_test(input).unwrap();
        assert_eq!(result.operations.len(), 1, "pinned behaviour: empty string shop_config with held buyer");
    }

    /// shop_config with schemaVersion as string, over-limit buyer.
    #[test]
    fn test_shop_config_schema_version_string_over_limit() {
        let input = make_input_with_step_and_shop_config(
            "60000.00",
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#),
            false,
            Some("CHECKOUT_COMPLETION"),
            Some(r#"{"schemaVersion": "1", "currencyCode": "INR"}"#),
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "pinned behaviour: shop_config schemaVersion string, over-limit");
    }
}
