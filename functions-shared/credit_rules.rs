//! Shared credit rules for checkout validation and payment method filtering.
//!
//! This module provides stricter metafield parsing with explicit status tracking.

use shopify_function::scalars::JsonValue;

/// Sentinel value for "no limit" - very large number that allows any cart.
pub const NO_LIMIT_SENTINEL: u64 = 999999999999999;

/// Supported shop currency for net-terms validation.
pub const SUPPORTED_SHOP_CURRENCY: &str = "INR";

/// Result of parsing a credit status metafield.
#[derive(Debug, Clone, PartialEq)]
pub enum StatusResult {
    /// No metafield present.
    Absent,
    /// Valid status with parsed fields.
    Valid(ParsedStatus),
    /// Metafield present but cannot be reliably parsed.
    Indeterminate,
}

/// A successfully parsed credit status.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedStatus {
    pub held: bool,
    pub currency_code: String,
    pub limit_paise: u64,
    pub exposure_paise: u64,
}

/// Result of parsing shop config metafield.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ShopConfigResult {
    /// Shop currency is INR.
    Inr,
    /// Shop currency is not INR.
    NonInr,
    /// Cannot determine shop currency.
    Unknown,
}

/// Decision from credit rule evaluation.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Decision {
    /// Allow the checkout/show payment methods.
    Allow,
    /// Block checkout/hide payment methods (generic reason).
    Block,
    /// Block due to account hold.
    BlockHold,
}

/// Parse an ASCII-digit string into u64. Returns None if not purely ASCII digits or overflow.
fn parse_ascii_digit_string(s: &str) -> Option<u64> {
    if s.is_empty() {
        return None;
    }
    for c in s.chars() {
        if !c.is_ascii_digit() {
            return None;
        }
    }
    s.parse::<u64>().ok()
}

/// Read credit status from metafield JSON value.
///
/// Parsing order (per spec):
/// 1. Not an object → Indeterminate
/// 2. hold == true → Valid with held=true (wins regardless of schemaVersion)
/// 3. hold missing or not a bool → Indeterminate
/// 4. schemaVersion not exactly integer 1 → Indeterminate
/// 5. currencyCode not a string → Indeterminate
/// 6. limitPaise or exposurePaise not ASCII-digit string fitting u64 → Indeterminate
pub fn read_status(json_value: Option<&JsonValue>) -> StatusResult {
    let json_value = match json_value {
        Some(v) => v,
        None => return StatusResult::Absent,
    };

    let obj = match json_value {
        JsonValue::Object(obj) => obj,
        JsonValue::Null => return StatusResult::Absent,
        _ => return StatusResult::Indeterminate,
    };

    // Check hold field first - held=true wins regardless of other fields
    let hold = match obj.get("hold") {
        Some(JsonValue::Boolean(b)) => *b,
        Some(_) => return StatusResult::Indeterminate,
        None => return StatusResult::Indeterminate,
    };

    // If held, return early with held status (no schemaVersion gate for hold)
    if hold {
        // For held status, we still need currency for the status struct
        // but we don't need valid limit/exposure since held always blocks
        let currency_code = match obj.get("currencyCode") {
            Some(JsonValue::String(s)) => s.clone(),
            _ => String::new(),
        };
        return StatusResult::Valid(ParsedStatus {
            held: true,
            currency_code,
            limit_paise: 0,
            exposure_paise: 0,
        });
    }

    // Not held - now apply schemaVersion gate
    let schema_version = match obj.get("schemaVersion") {
        Some(JsonValue::Number(n)) => *n as i64,
        _ => return StatusResult::Indeterminate,
    };
    if schema_version != 1 {
        return StatusResult::Indeterminate;
    }

    // currencyCode must be a string
    let currency_code = match obj.get("currencyCode") {
        Some(JsonValue::String(s)) => s.clone(),
        _ => return StatusResult::Indeterminate,
    };

    // limitPaise must be ASCII-digit string fitting u64
    let limit_paise = match obj.get("limitPaise") {
        Some(JsonValue::String(s)) => match parse_ascii_digit_string(s) {
            Some(v) => v,
            None => return StatusResult::Indeterminate,
        },
        _ => return StatusResult::Indeterminate,
    };

    // exposurePaise must be ASCII-digit string fitting u64
    let exposure_paise = match obj.get("exposurePaise") {
        Some(JsonValue::String(s)) => match parse_ascii_digit_string(s) {
            Some(v) => v,
            None => return StatusResult::Indeterminate,
        },
        _ => return StatusResult::Indeterminate,
    };

    StatusResult::Valid(ParsedStatus {
        held: false,
        currency_code,
        limit_paise,
        exposure_paise,
    })
}

/// Read shop config from metafield JSON value.
///
/// Valid only when schemaVersion is integer 1 and currencyCode is a string.
pub fn read_shop_config(json_value: Option<&JsonValue>) -> ShopConfigResult {
    let json_value = match json_value {
        Some(v) => v,
        None => return ShopConfigResult::Unknown,
    };

    let obj = match json_value {
        JsonValue::Object(obj) => obj,
        _ => return ShopConfigResult::Unknown,
    };

    // schemaVersion must be exactly integer 1
    let schema_version = match obj.get("schemaVersion") {
        Some(JsonValue::Number(n)) => *n as i64,
        _ => return ShopConfigResult::Unknown,
    };
    if schema_version != 1 {
        return ShopConfigResult::Unknown;
    }

    // currencyCode must be a string
    let currency_code = match obj.get("currencyCode") {
        Some(JsonValue::String(s)) => s.as_str(),
        _ => return ShopConfigResult::Unknown,
    };

    if currency_code == SUPPORTED_SHOP_CURRENCY {
        ShopConfigResult::Inr
    } else {
        ShopConfigResult::NonInr
    }
}

/// Check if account is held (for payment method hiding).
/// Returns true only for valid held status, false otherwise (including Indeterminate).
pub fn is_held(status: &StatusResult) -> bool {
    matches!(status, StatusResult::Valid(s) if s.held)
}

/// Check if account has no remaining credit headroom.
/// Returns true when exposure >= limit (i.e., no room for any additional purchase).
pub fn is_over_limit(status: &StatusResult) -> bool {
    match status {
        StatusResult::Valid(s) if !s.held => s.exposure_paise >= s.limit_paise,
        _ => false,
    }
}

/// Decision parameters for validation function.
pub struct DecisionInput<'a> {
    pub status: &'a StatusResult,
    pub shop_config: ShopConfigResult,
    pub cart_currency: &'a str,
    pub cart_total_paise: Option<u64>,
}

/// Evaluate credit rules and decide whether to block.
///
/// Decision order:
/// 1. Held → BlockHold
/// 2. Indeterminate → Block
/// 3. Absent → Allow
/// 4. NonInr shop → Allow
/// 5. INR shop with non-INR cart → Allow
/// 6. Non-INR status with INR cart → Block
/// 7. Unparseable cart total → Block (unless no-limit sentinel)
/// 8. checked_add overflow → Block
/// 9. exposure + total > limit → Block (equal is allowed)
/// 10. Otherwise → Allow
pub fn decide(input: &DecisionInput) -> Decision {
    // 1. Held → BlockHold
    if is_held(input.status) {
        return Decision::BlockHold;
    }

    // 2. Indeterminate → Block
    if matches!(input.status, StatusResult::Indeterminate) {
        return Decision::Block;
    }

    // 3. Absent → Allow
    let status = match input.status {
        StatusResult::Valid(s) => s,
        StatusResult::Absent => return Decision::Allow,
        StatusResult::Indeterminate => unreachable!(),
    };

    // 4. NonInr shop → Allow
    if input.shop_config == ShopConfigResult::NonInr {
        return Decision::Allow;
    }

    // 5. INR shop with non-INR cart → Allow
    if input.shop_config == ShopConfigResult::Inr && input.cart_currency != SUPPORTED_SHOP_CURRENCY {
        return Decision::Allow;
    }

    // 6. Non-INR status with INR cart → Block
    if status.currency_code != SUPPORTED_SHOP_CURRENCY && input.cart_currency == SUPPORTED_SHOP_CURRENCY {
        return Decision::Block;
    }

    // Currency mismatch between status and cart (different non-INR)
    if status.currency_code != input.cart_currency {
        return Decision::Allow;
    }

    // 7. Unparseable cart total → Block (unless no-limit sentinel)
    let cart_total = match input.cart_total_paise {
        Some(v) => v,
        None => {
            if status.limit_paise == NO_LIMIT_SENTINEL {
                return Decision::Allow;
            }
            return Decision::Block;
        }
    };

    // 8. checked_add overflow → Block
    let total_exposure = match status.exposure_paise.checked_add(cart_total) {
        Some(v) => v,
        None => return Decision::Block,
    };

    // 9. Over-limit (strict >)
    if total_exposure > status.limit_paise {
        return Decision::Block;
    }

    // 10. Otherwise → Allow
    Decision::Allow
}

/// Decision parameters for payment customization function.
pub struct PaymentDecisionInput<'a> {
    pub status: &'a StatusResult,
    pub shop_config: ShopConfigResult,
    pub cart_currency: &'a str,
}

/// Evaluate whether to hide deferred payment methods.
///
/// Hide when:
/// - Account is held
/// - Status is Indeterminate
/// - No remaining credit headroom (exposure >= limit)
/// - Non-INR shop (net-terms not available)
/// - INR shop with non-INR cart (currency mismatch)
/// - Unknown shop config with non-INR cart (conservative)
pub fn should_hide_deferred(input: &PaymentDecisionInput) -> bool {
    // Held → hide
    if is_held(input.status) {
        return true;
    }

    // Indeterminate → hide
    if matches!(input.status, StatusResult::Indeterminate) {
        return true;
    }

    // Check if over limit (no headroom)
    if is_over_limit(input.status) {
        return true;
    }

    // Non-INR shop → hide (net-terms not available)
    if input.shop_config == ShopConfigResult::NonInr {
        return true;
    }

    // Unknown shop config with non-INR cart → hide (conservative)
    if input.shop_config == ShopConfigResult::Unknown && input.cart_currency != SUPPORTED_SHOP_CURRENCY {
        return true;
    }

    // INR shop with non-INR cart → hide (currency mismatch)
    if input.shop_config == ShopConfigResult::Inr && input.cart_currency != SUPPORTED_SHOP_CURRENCY {
        return true;
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn to_json_value(v: serde_json::Value) -> JsonValue {
        match v {
            serde_json::Value::Null => JsonValue::Null,
            serde_json::Value::Bool(b) => JsonValue::Boolean(b),
            serde_json::Value::Number(n) => JsonValue::Number(n.as_f64().unwrap()),
            serde_json::Value::String(s) => JsonValue::String(s),
            serde_json::Value::Array(arr) => {
                JsonValue::Array(arr.into_iter().map(to_json_value).collect())
            }
            serde_json::Value::Object(obj) => {
                JsonValue::Object(obj.into_iter().map(|(k, v)| (k, to_json_value(v))).collect())
            }
        }
    }

    // =========================================================================
    // read_status tests
    // =========================================================================

    #[test]
    fn status_absent_when_none() {
        assert_eq!(read_status(None), StatusResult::Absent);
    }

    #[test]
    fn status_absent_when_null() {
        let v = to_json_value(json!(null));
        assert_eq!(read_status(Some(&v)), StatusResult::Absent);
    }

    #[test]
    fn status_indeterminate_when_not_object() {
        let v = to_json_value(json!("string"));
        assert_eq!(read_status(Some(&v)), StatusResult::Indeterminate);

        let v = to_json_value(json!(123));
        assert_eq!(read_status(Some(&v)), StatusResult::Indeterminate);

        let v = to_json_value(json!([1, 2, 3]));
        assert_eq!(read_status(Some(&v)), StatusResult::Indeterminate);
    }

    #[test]
    fn status_valid_held_ignores_schema_version() {
        // hold=true with wrong schemaVersion still returns Valid(held)
        let v = to_json_value(json!({
            "schemaVersion": 999,
            "currencyCode": "INR",
            "hold": true,
            "limitPaise": "10000000",
            "exposurePaise": "5000000"
        }));
        let result = read_status(Some(&v));
        assert!(matches!(result, StatusResult::Valid(s) if s.held));
    }

    #[test]
    fn status_valid_not_held_requires_schema_version() {
        // hold=false with wrong schemaVersion is Indeterminate
        let v = to_json_value(json!({
            "schemaVersion": 999,
            "currencyCode": "INR",
            "hold": false,
            "limitPaise": "10000000",
            "exposurePaise": "5000000"
        }));
        assert_eq!(read_status(Some(&v)), StatusResult::Indeterminate);
    }

    #[test]
    fn status_indeterminate_when_hold_missing() {
        let v = to_json_value(json!({
            "schemaVersion": 1,
            "currencyCode": "INR",
            "limitPaise": "10000000",
            "exposurePaise": "5000000"
        }));
        assert_eq!(read_status(Some(&v)), StatusResult::Indeterminate);
    }

    #[test]
    fn status_indeterminate_when_hold_not_bool() {
        let v = to_json_value(json!({
            "schemaVersion": 1,
            "currencyCode": "INR",
            "hold": "true",
            "limitPaise": "10000000",
            "exposurePaise": "5000000"
        }));
        assert_eq!(read_status(Some(&v)), StatusResult::Indeterminate);
    }

    #[test]
    fn status_indeterminate_when_currency_not_string() {
        let v = to_json_value(json!({
            "schemaVersion": 1,
            "currencyCode": 356,
            "hold": false,
            "limitPaise": "10000000",
            "exposurePaise": "5000000"
        }));
        assert_eq!(read_status(Some(&v)), StatusResult::Indeterminate);
    }

    #[test]
    fn status_indeterminate_when_limit_not_ascii_digits() {
        let v = to_json_value(json!({
            "schemaVersion": 1,
            "currencyCode": "INR",
            "hold": false,
            "limitPaise": "abc",
            "exposurePaise": "5000000"
        }));
        assert_eq!(read_status(Some(&v)), StatusResult::Indeterminate);
    }

    #[test]
    fn status_indeterminate_when_limit_has_negative() {
        let v = to_json_value(json!({
            "schemaVersion": 1,
            "currencyCode": "INR",
            "hold": false,
            "limitPaise": "-10000000",
            "exposurePaise": "5000000"
        }));
        assert_eq!(read_status(Some(&v)), StatusResult::Indeterminate);
    }

    #[test]
    fn status_indeterminate_when_exposure_not_ascii_digits() {
        let v = to_json_value(json!({
            "schemaVersion": 1,
            "currencyCode": "INR",
            "hold": false,
            "limitPaise": "10000000",
            "exposurePaise": "abc"
        }));
        assert_eq!(read_status(Some(&v)), StatusResult::Indeterminate);
    }

    #[test]
    fn status_valid_with_correct_fields() {
        let v = to_json_value(json!({
            "schemaVersion": 1,
            "currencyCode": "INR",
            "hold": false,
            "limitPaise": "10000000",
            "exposurePaise": "5000000"
        }));
        let result = read_status(Some(&v));
        match result {
            StatusResult::Valid(s) => {
                assert!(!s.held);
                assert_eq!(s.currency_code, "INR");
                assert_eq!(s.limit_paise, 10000000);
                assert_eq!(s.exposure_paise, 5000000);
            }
            _ => panic!("Expected Valid status"),
        }
    }

    // =========================================================================
    // read_shop_config tests
    // =========================================================================

    #[test]
    fn shop_config_unknown_when_none() {
        assert_eq!(read_shop_config(None), ShopConfigResult::Unknown);
    }

    #[test]
    fn shop_config_unknown_when_not_object() {
        let v = to_json_value(json!("string"));
        assert_eq!(read_shop_config(Some(&v)), ShopConfigResult::Unknown);
    }

    #[test]
    fn shop_config_unknown_when_wrong_schema_version() {
        let v = to_json_value(json!({
            "schemaVersion": 999,
            "currencyCode": "INR"
        }));
        assert_eq!(read_shop_config(Some(&v)), ShopConfigResult::Unknown);
    }

    #[test]
    fn shop_config_unknown_when_currency_not_string() {
        let v = to_json_value(json!({
            "schemaVersion": 1,
            "currencyCode": 356
        }));
        assert_eq!(read_shop_config(Some(&v)), ShopConfigResult::Unknown);
    }

    #[test]
    fn shop_config_inr_when_valid() {
        let v = to_json_value(json!({
            "schemaVersion": 1,
            "currencyCode": "INR"
        }));
        assert_eq!(read_shop_config(Some(&v)), ShopConfigResult::Inr);
    }

    #[test]
    fn shop_config_non_inr_when_valid_usd() {
        let v = to_json_value(json!({
            "schemaVersion": 1,
            "currencyCode": "USD"
        }));
        assert_eq!(read_shop_config(Some(&v)), ShopConfigResult::NonInr);
    }

    // =========================================================================
    // decide tests
    // =========================================================================

    #[test]
    fn decide_block_hold_when_held() {
        let status = StatusResult::Valid(ParsedStatus {
            held: true,
            currency_code: "INR".to_string(),
            limit_paise: 10000000,
            exposure_paise: 5000000,
        });
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
            cart_total_paise: Some(100000),
        };
        assert_eq!(decide(&input), Decision::BlockHold);
    }

    #[test]
    fn decide_block_when_indeterminate() {
        let status = StatusResult::Indeterminate;
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
            cart_total_paise: Some(100000),
        };
        assert_eq!(decide(&input), Decision::Block);
    }

    #[test]
    fn decide_allow_when_absent() {
        let status = StatusResult::Absent;
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
            cart_total_paise: Some(100000),
        };
        assert_eq!(decide(&input), Decision::Allow);
    }

    #[test]
    fn decide_allow_when_non_inr_shop() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "USD".to_string(),
            limit_paise: 10000000,
            exposure_paise: 15000000, // over limit
        });
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::NonInr,
            cart_currency: "USD",
            cart_total_paise: Some(100000),
        };
        assert_eq!(decide(&input), Decision::Allow);
    }

    #[test]
    fn decide_allow_inr_shop_non_inr_cart() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "INR".to_string(),
            limit_paise: 10000000,
            exposure_paise: 5000000,
        });
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "USD",
            cart_total_paise: Some(100000),
        };
        assert_eq!(decide(&input), Decision::Allow);
    }

    #[test]
    fn decide_block_non_inr_status_inr_cart() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "USD".to_string(),
            limit_paise: 10000000,
            exposure_paise: 5000000,
        });
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Unknown,
            cart_currency: "INR",
            cart_total_paise: Some(100000),
        };
        assert_eq!(decide(&input), Decision::Block);
    }

    #[test]
    fn decide_allow_no_limit_sentinel_unparseable_cart() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "INR".to_string(),
            limit_paise: NO_LIMIT_SENTINEL,
            exposure_paise: 5000000,
        });
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
            cart_total_paise: None, // unparseable
        };
        assert_eq!(decide(&input), Decision::Allow);
    }

    #[test]
    fn decide_block_unparseable_cart_without_sentinel() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "INR".to_string(),
            limit_paise: 10000000,
            exposure_paise: 5000000,
        });
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
            cart_total_paise: None, // unparseable
        };
        assert_eq!(decide(&input), Decision::Block);
    }

    #[test]
    fn decide_allow_exactly_at_limit() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "INR".to_string(),
            limit_paise: 10000000,
            exposure_paise: 5000000,
        });
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
            cart_total_paise: Some(5000000), // exactly at limit
        };
        assert_eq!(decide(&input), Decision::Allow);
    }

    #[test]
    fn decide_block_one_paise_over_limit() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "INR".to_string(),
            limit_paise: 10000000,
            exposure_paise: 5000000,
        });
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
            cart_total_paise: Some(5000001), // one over limit
        };
        assert_eq!(decide(&input), Decision::Block);
    }

    #[test]
    fn decide_allow_under_limit() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "INR".to_string(),
            limit_paise: 10000000,
            exposure_paise: 5000000,
        });
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
            cart_total_paise: Some(4000000),
        };
        assert_eq!(decide(&input), Decision::Allow);
    }

    // =========================================================================
    // should_hide_deferred tests
    // =========================================================================

    #[test]
    fn hide_when_held() {
        let status = StatusResult::Valid(ParsedStatus {
            held: true,
            currency_code: "INR".to_string(),
            limit_paise: 10000000,
            exposure_paise: 5000000,
        });
        let input = PaymentDecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
        };
        assert!(should_hide_deferred(&input));
    }

    #[test]
    fn hide_when_indeterminate() {
        let status = StatusResult::Indeterminate;
        let input = PaymentDecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
        };
        assert!(should_hide_deferred(&input));
    }

    #[test]
    fn hide_when_over_limit_no_headroom() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "INR".to_string(),
            limit_paise: 10000000,
            exposure_paise: 10000000, // at limit, no headroom
        });
        let input = PaymentDecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
        };
        assert!(should_hide_deferred(&input));
    }

    #[test]
    fn hide_when_non_inr_shop() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "USD".to_string(),
            limit_paise: 10000000,
            exposure_paise: 5000000,
        });
        let input = PaymentDecisionInput {
            status: &status,
            shop_config: ShopConfigResult::NonInr,
            cart_currency: "USD",
        };
        assert!(should_hide_deferred(&input));
    }

    #[test]
    fn hide_when_unknown_shop_non_inr_cart() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "INR".to_string(),
            limit_paise: 10000000,
            exposure_paise: 5000000,
        });
        let input = PaymentDecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Unknown,
            cart_currency: "USD",
        };
        assert!(should_hide_deferred(&input));
    }

    #[test]
    fn hide_when_inr_shop_non_inr_cart() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "INR".to_string(),
            limit_paise: 10000000,
            exposure_paise: 5000000,
        });
        let input = PaymentDecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "USD",
        };
        assert!(should_hide_deferred(&input));
    }

    #[test]
    fn show_when_absent() {
        let status = StatusResult::Absent;
        let input = PaymentDecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
        };
        assert!(!should_hide_deferred(&input));
    }

    #[test]
    fn show_when_valid_under_limit() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "INR".to_string(),
            limit_paise: 10000000,
            exposure_paise: 5000000,
        });
        let input = PaymentDecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
        };
        assert!(!should_hide_deferred(&input));
    }

    // =========================================================================
    // Shared table test - runs in both crates
    // =========================================================================

    /// Table test verifying validation blocks exactly when payment hides
    /// for hold and Indeterminate cases, and over-limit hides.
    #[test]
    fn shared_table_validation_payment_consistency() {
        struct TestCase {
            name: &'static str,
            status: StatusResult,
            shop_config: ShopConfigResult,
            cart_currency: &'static str,
            cart_total_paise: Option<u64>,
            expect_block: bool,
            expect_hide: bool,
        }

        let cases = vec![
            TestCase {
                name: "held blocks and hides",
                status: StatusResult::Valid(ParsedStatus {
                    held: true,
                    currency_code: "INR".to_string(),
                    limit_paise: 10000000,
                    exposure_paise: 5000000,
                }),
                shop_config: ShopConfigResult::Inr,
                cart_currency: "INR",
                cart_total_paise: Some(100000),
                expect_block: true,
                expect_hide: true,
            },
            TestCase {
                name: "indeterminate blocks and hides",
                status: StatusResult::Indeterminate,
                shop_config: ShopConfigResult::Inr,
                cart_currency: "INR",
                cart_total_paise: Some(100000),
                expect_block: true,
                expect_hide: true,
            },
            TestCase {
                name: "over limit hides but validation blocks",
                status: StatusResult::Valid(ParsedStatus {
                    held: false,
                    currency_code: "INR".to_string(),
                    limit_paise: 10000000,
                    exposure_paise: 5000000,
                }),
                shop_config: ShopConfigResult::Inr,
                cart_currency: "INR",
                cart_total_paise: Some(6000000), // over limit
                expect_block: true,
                expect_hide: false, // has headroom, doesn't hide preemptively
            },
            TestCase {
                name: "at limit no headroom hides",
                status: StatusResult::Valid(ParsedStatus {
                    held: false,
                    currency_code: "INR".to_string(),
                    limit_paise: 10000000,
                    exposure_paise: 10000000, // no headroom
                }),
                shop_config: ShopConfigResult::Inr,
                cart_currency: "INR",
                cart_total_paise: Some(1), // any amount blocks
                expect_block: true,
                expect_hide: true, // no headroom = hide
            },
            TestCase {
                name: "absent allows and shows",
                status: StatusResult::Absent,
                shop_config: ShopConfigResult::Inr,
                cart_currency: "INR",
                cart_total_paise: Some(100000),
                expect_block: false,
                expect_hide: false,
            },
            TestCase {
                name: "under limit allows and shows",
                status: StatusResult::Valid(ParsedStatus {
                    held: false,
                    currency_code: "INR".to_string(),
                    limit_paise: 10000000,
                    exposure_paise: 5000000,
                }),
                shop_config: ShopConfigResult::Inr,
                cart_currency: "INR",
                cart_total_paise: Some(4000000),
                expect_block: false,
                expect_hide: false,
            },
        ];

        for tc in cases {
            let decision_input = DecisionInput {
                status: &tc.status,
                shop_config: tc.shop_config,
                cart_currency: tc.cart_currency,
                cart_total_paise: tc.cart_total_paise,
            };
            let decision = decide(&decision_input);
            let blocks = matches!(decision, Decision::Block | Decision::BlockHold);

            let payment_input = PaymentDecisionInput {
                status: &tc.status,
                shop_config: tc.shop_config,
                cart_currency: tc.cart_currency,
            };
            let hides = should_hide_deferred(&payment_input);

            assert_eq!(
                blocks, tc.expect_block,
                "{}: expected block={}, got block={}",
                tc.name, tc.expect_block, blocks
            );
            assert_eq!(
                hides, tc.expect_hide,
                "{}: expected hide={}, got hide={}",
                tc.name, tc.expect_hide, hides
            );
        }
    }

    // =========================================================================
    // Pinning tests
    // =========================================================================

    #[test]
    fn pinned_cart_interaction_allow() {
        // Cart interaction step should be handled by caller, not this module
        // This test just verifies absent status allows
        let status = StatusResult::Absent;
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
            cart_total_paise: Some(100000),
        };
        assert_eq!(decide(&input), Decision::Allow);
    }

    #[test]
    fn pinned_no_buyer_allow() {
        // No buyer = absent status
        let status = StatusResult::Absent;
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
            cart_total_paise: Some(100000),
        };
        assert_eq!(decide(&input), Decision::Allow);
    }

    #[test]
    fn pinned_absent_metafield_allow() {
        let status = StatusResult::Absent;
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
            cart_total_paise: Some(100000),
        };
        assert_eq!(decide(&input), Decision::Allow);
    }

    #[test]
    fn pinned_equal_to_limit_allow() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "INR".to_string(),
            limit_paise: 10000000,
            exposure_paise: 5000000,
        });
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
            cart_total_paise: Some(5000000), // exactly at limit
        };
        assert_eq!(decide(&input), Decision::Allow);
    }

    #[test]
    fn pinned_no_limit_sentinel_allow() {
        let status = StatusResult::Valid(ParsedStatus {
            held: false,
            currency_code: "INR".to_string(),
            limit_paise: NO_LIMIT_SENTINEL,
            exposure_paise: 5000000,
        });
        let input = DecisionInput {
            status: &status,
            shop_config: ShopConfigResult::Inr,
            cart_currency: "INR",
            cart_total_paise: Some(100000000000), // very large cart
        };
        assert_eq!(decide(&input), Decision::Allow);
    }
}
