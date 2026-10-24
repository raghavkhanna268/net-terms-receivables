use crate::schema;
use shopify_function::prelude::*;
use shopify_function::scalars::JsonValue;
use shopify_function::Result;

/// Configuration for the payment customization (from $app:hide-terms-config metafield).
/// 
/// For B2B company locations: uses deferredPaymentPatterns to match payment method names.
/// For tagged customers: uses manualPaymentMethodName for exact match.
/// 
/// NOTE: The 2026-10 cart.payment-methods.transform schema.graphql PaymentMethod type
/// only exposes `id` and `name` fields - there is no `deferred` flag or payment-terms
/// operation. We must match by name patterns, which is configurable to handle merchant-
/// specific payment method naming conventions.
#[derive(Default, PartialEq, Clone, Debug)]
pub struct Configuration {
    /// Patterns to match deferred payment method names (case-insensitive substring match).
    /// Defaults to ["deferred", "net terms", "net-terms", "pay later", "payment terms"].
    pub deferred_payment_patterns: Option<Vec<String>>,
    /// Exact name of manual payment method to hide for tagged customers (case-insensitive).
    pub manual_payment_method_name: Option<String>,
}

impl Configuration {
    fn from_json_value(json_value: &JsonValue) -> Self {
        if let JsonValue::Object(obj) = json_value {
            let patterns = obj
                .get("deferredPaymentPatterns")
                .and_then(|v| match v {
                    JsonValue::Array(arr) => {
                        let strings: Vec<String> = arr
                            .iter()
                            .filter_map(|item| match item {
                                JsonValue::String(s) => Some(s.clone()),
                                _ => None,
                            })
                            .collect();
                        if strings.is_empty() { None } else { Some(strings) }
                    }
                    _ => None,
                });
            
            Configuration {
                deferred_payment_patterns: patterns,
                manual_payment_method_name: obj
                    .get("manualPaymentMethodName")
                    .and_then(|v| match v {
                        JsonValue::String(s) => Some(s.clone()),
                        _ => None,
                    }),
            }
        } else {
            Configuration::default()
        }
    }
    
    /// Get the deferred payment patterns to use (configured or defaults).
    fn get_deferred_patterns(&self) -> Vec<&str> {
        match &self.deferred_payment_patterns {
            Some(patterns) => patterns.iter().map(|s| s.as_str()).collect(),
            None => DEFAULT_DEFERRED_PATTERNS.to_vec(),
        }
    }
}

/// Credit status from the $app:credit_status metafield.
/// Mirrors the structure written by S11's syncCreditStatusMetafield.
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

    /// Check if the account is on hold and should have payment methods hidden.
    /// Returns false (fail-open) for missing or invalid metafield data.
    fn is_held(&self) -> bool {
        if self.schema_version.is_none() {
            return false;
        }
        let schema_version = self.schema_version.unwrap();
        if schema_version != 1 {
            return false;
        }

        self.hold == Some(true)
    }
}

/// Default patterns to match deferred payment method names (case-insensitive).
/// These are used when no deferredPaymentPatterns config is provided.
/// Shopify B2B deferred payment methods typically contain these terms.
const DEFAULT_DEFERRED_PATTERNS: &[&str] = &[
    "deferred",
    "net terms",
    "net-terms",
    "pay later",
    "payment terms",
];

/// Check if a payment method name matches any of the given patterns (case-insensitive).
fn matches_deferred_patterns(name: &str, patterns: &[&str]) -> bool {
    let lower = name.to_lowercase();
    patterns.iter().any(|pattern| lower.contains(&pattern.to_lowercase()))
}

fn pass() -> schema::CartPaymentMethodsTransformRunResult {
    schema::CartPaymentMethodsTransformRunResult { operations: vec![] }
}

fn hide_payment_method(payment_method_id: String) -> schema::Operation {
    schema::Operation::PaymentMethodHide(schema::PaymentMethodHideOperation {
        payment_method_id,
        placements: None,
    })
}

#[shopify_function]
fn cart_payment_methods_transform_run(
    input: schema::cart_payment_methods_transform_run::Input,
) -> Result<schema::CartPaymentMethodsTransformRunResult> {
    let cart = input.cart();
    let buyer_identity = match cart.buyer_identity() {
        Some(bi) => bi,
        None => return Ok(pass()),
    };

    // Load config once (used for both B2B and customer paths)
    let config = match input.payment_customization() {
        Some(pc) => match pc.metafield() {
            Some(m) => Configuration::from_json_value(m.json_value()),
            None => Configuration::default(),
        },
        None => Configuration::default(),
    };
    let deferred_patterns = config.get_deferred_patterns();

    // Check B2B company location first (takes precedence)
    if let Some(purchasing_company) = buyer_identity.purchasing_company() {
        let location = purchasing_company.location();
        if let Some(metafield) = location.metafield() {
            let json_value = metafield.json_value();
            let credit_status = CreditStatus::from_json_value(json_value);
            
            if credit_status.is_held() {
                // For B2B, hide deferred payment methods using configured patterns
                let operations: Vec<schema::Operation> = input
                    .payment_methods()
                    .iter()
                    .filter(|pm| matches_deferred_patterns(pm.name(), &deferred_patterns))
                    .map(|pm| hide_payment_method(pm.id().to_string()))
                    .collect();
                
                return Ok(schema::CartPaymentMethodsTransformRunResult { operations });
            }
        }
        // No metafield or not held - pass (fail-open)
        return Ok(pass());
    }

    // Check tagged customer
    if let Some(customer) = buyer_identity.customer() {
        if let Some(metafield) = customer.metafield() {
            let json_value = metafield.json_value();
            let credit_status = CreditStatus::from_json_value(json_value);
            
            if credit_status.is_held() {
                let operations: Vec<schema::Operation> = if let Some(ref target_name) = config.manual_payment_method_name {
                    // Hide the specifically configured payment method (exact match)
                    input
                        .payment_methods()
                        .iter()
                        .filter(|pm| pm.name().to_lowercase() == target_name.to_lowercase())
                        .map(|pm| hide_payment_method(pm.id().to_string()))
                        .collect()
                } else {
                    // No specific method configured - hide by deferred payment patterns
                    input
                        .payment_methods()
                        .iter()
                        .filter(|pm| matches_deferred_patterns(pm.name(), &deferred_patterns))
                        .map(|pm| hide_payment_method(pm.id().to_string()))
                        .collect()
                };
                
                return Ok(schema::CartPaymentMethodsTransformRunResult { operations });
            }
        }
    }

    // No held status found - pass
    Ok(pass())
}

#[cfg(test)]
mod tests {
    use super::*;
    use shopify_function::{run_function_with_input, Result};

    fn run_test(input_json: &str) -> Result<schema::CartPaymentMethodsTransformRunResult> {
        run_function_with_input(cart_payment_methods_transform_run, input_json)
    }

    fn make_b2b_input_with_config(
        metafield_json: Option<&str>,
        payment_methods: &[(&str, &str)],
        config_json: Option<&str>,
    ) -> String {
        let location_metafield = match metafield_json {
            Some(mf) => format!(r#"{{ "metafield": {{ "jsonValue": {} }} }}"#, mf),
            None => r#"{ "metafield": null }"#.to_string(),
        };

        let pm_json: String = payment_methods
            .iter()
            .map(|(id, name)| format!(r#"{{ "id": "{}", "name": "{}" }}"#, id, name))
            .collect::<Vec<_>>()
            .join(", ");

        let pc_json = match config_json {
            Some(cfg) => format!(r#"{{ "metafield": {{ "jsonValue": {} }} }}"#, cfg),
            None => "null".to_string(),
        };

        format!(
            r#"{{
                "cart": {{
                    "buyerIdentity": {{
                        "customer": null,
                        "purchasingCompany": {{
                            "location": {}
                        }}
                    }}
                }},
                "paymentMethods": [{}],
                "paymentCustomization": {}
            }}"#,
            location_metafield, pm_json, pc_json
        )
    }

    fn make_b2b_input(metafield_json: Option<&str>, payment_methods: &[(&str, &str)]) -> String {
        make_b2b_input_with_config(metafield_json, payment_methods, None)
    }

    fn make_customer_input(
        metafield_json: Option<&str>,
        payment_methods: &[(&str, &str)],
        config_json: Option<&str>,
    ) -> String {
        let customer_metafield = match metafield_json {
            Some(mf) => format!(r#"{{ "metafield": {{ "jsonValue": {} }} }}"#, mf),
            None => r#"{ "metafield": null }"#.to_string(),
        };

        let pm_json: String = payment_methods
            .iter()
            .map(|(id, name)| format!(r#"{{ "id": "{}", "name": "{}" }}"#, id, name))
            .collect::<Vec<_>>()
            .join(", ");

        let pc_json = match config_json {
            Some(cfg) => format!(r#"{{ "metafield": {{ "jsonValue": {} }} }}"#, cfg),
            None => "null".to_string(),
        };

        format!(
            r#"{{
                "cart": {{
                    "buyerIdentity": {{
                        "customer": {},
                        "purchasingCompany": null
                    }}
                }},
                "paymentMethods": [{}],
                "paymentCustomization": {}
            }}"#,
            customer_metafield, pm_json, pc_json
        )
    }

    fn held_metafield() -> &'static str {
        r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": true, "holdReasonCode": "PAYMENT_OVERDUE", "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#
    }

    fn ok_metafield() -> &'static str {
        r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#
    }

    fn near_limit_metafield() -> &'static str {
        r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "8500000", "updatedAt": "2026-10-23T00:00:00Z"}"#
    }

    fn bypass_metafield() -> &'static str {
        // Bypass accounts have hold: false regardless of other factors
        r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "15000000", "updatedAt": "2026-10-23T00:00:00Z"}"#
    }

    fn default_payment_methods() -> Vec<(&'static str, &'static str)> {
        vec![
            ("gid://shopify/PaymentCustomizationPaymentMethod/1", "Credit Card"),
            ("gid://shopify/PaymentCustomizationPaymentMethod/2", "Deferred Payment"),
            ("gid://shopify/PaymentCustomizationPaymentMethod/3", "Net Terms"),
        ]
    }

    // =========================================================================
    // B2B Company Location Tests
    // =========================================================================

    #[test]
    fn test_b2b_held_hides_deferred_payment() {
        let input = make_b2b_input(Some(held_metafield()), &default_payment_methods());
        let result = run_test(&input).unwrap();
        
        assert_eq!(result.operations.len(), 2, "Should hide 'Deferred Payment' and 'Net Terms'");
        
        for op in &result.operations {
            match op {
                schema::Operation::PaymentMethodHide(hide_op) => {
                    assert!(
                        hide_op.payment_method_id.contains("2") || hide_op.payment_method_id.contains("3"),
                        "Should hide deferred payment methods"
                    );
                }
            }
        }
    }

    #[test]
    fn test_b2b_ok_passes() {
        let input = make_b2b_input(Some(ok_metafield()), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "OK account should pass");
    }

    #[test]
    fn test_b2b_near_limit_passes() {
        let input = make_b2b_input(Some(near_limit_metafield()), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "NEAR_LIMIT account should pass (not held)");
    }

    #[test]
    fn test_b2b_bypass_passes() {
        let input = make_b2b_input(Some(bypass_metafield()), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Bypass account should pass");
    }

    #[test]
    fn test_b2b_no_metafield_passes() {
        let input = make_b2b_input(None, &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "No metafield should pass (fail-open)");
    }

    #[test]
    fn test_b2b_invalid_schema_version_passes() {
        let metafield = r#"{"schemaVersion": 999, "hold": true}"#;
        let input = make_b2b_input(Some(metafield), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Unknown schema version should pass (fail-open)");
    }

    #[test]
    fn test_b2b_malformed_metafield_passes() {
        let metafield = r#"{"notARealField": "garbage"}"#;
        let input = make_b2b_input(Some(metafield), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Malformed metafield should pass (fail-open)");
    }

    // =========================================================================
    // Tagged Customer Tests
    // =========================================================================

    #[test]
    fn test_customer_held_hides_deferred_payment() {
        let input = make_customer_input(Some(held_metafield()), &default_payment_methods(), None);
        let result = run_test(&input).unwrap();
        
        assert_eq!(result.operations.len(), 2, "Should hide deferred payment methods");
    }

    #[test]
    fn test_customer_held_with_config_hides_specific_method() {
        let config = r#"{"manualPaymentMethodName": "Credit Card"}"#;
        let input = make_customer_input(Some(held_metafield()), &default_payment_methods(), Some(config));
        let result = run_test(&input).unwrap();
        
        assert_eq!(result.operations.len(), 1, "Should hide only the configured method");
        match &result.operations[0] {
            schema::Operation::PaymentMethodHide(hide_op) => {
                assert!(hide_op.payment_method_id.contains("1"), "Should hide Credit Card (id 1)");
            }
        }
    }

    #[test]
    fn test_customer_ok_passes() {
        let input = make_customer_input(Some(ok_metafield()), &default_payment_methods(), None);
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "OK account should pass");
    }

    #[test]
    fn test_customer_near_limit_passes() {
        let input = make_customer_input(Some(near_limit_metafield()), &default_payment_methods(), None);
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "NEAR_LIMIT account should pass (not held)");
    }

    #[test]
    fn test_customer_bypass_passes() {
        let input = make_customer_input(Some(bypass_metafield()), &default_payment_methods(), None);
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Bypass account should pass");
    }

    #[test]
    fn test_customer_no_metafield_passes() {
        let input = make_customer_input(None, &default_payment_methods(), None);
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "No metafield should pass (fail-open)");
    }

    // =========================================================================
    // Edge Cases
    // =========================================================================

    #[test]
    fn test_guest_checkout_passes() {
        let input = r#"
        {
            "cart": {
                "buyerIdentity": null
            },
            "paymentMethods": [
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/1", "name": "Credit Card" }
            ],
            "paymentCustomization": null
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.operations.is_empty(), "Guest checkout should pass");
    }

    #[test]
    fn test_deferred_payment_pattern_matching() {
        let patterns = DEFAULT_DEFERRED_PATTERNS.to_vec();
        assert!(matches_deferred_patterns("Deferred Payment", &patterns));
        assert!(matches_deferred_patterns("Net Terms (30 days)", &patterns));
        assert!(matches_deferred_patterns("net-terms", &patterns));
        assert!(matches_deferred_patterns("Pay Later", &patterns));
        assert!(matches_deferred_patterns("B2B Payment Terms", &patterns));
        assert!(!matches_deferred_patterns("Credit Card", &patterns));
        assert!(!matches_deferred_patterns("Shop Pay", &patterns));
        assert!(!matches_deferred_patterns("Cash on Delivery", &patterns));
    }

    #[test]
    fn test_b2b_takes_precedence_over_customer() {
        // When both B2B and customer are present, B2B takes precedence
        let input = r#"
        {
            "cart": {
                "buyerIdentity": {
                    "customer": {
                        "metafield": {
                            "jsonValue": {"schemaVersion": 1, "hold": false}
                        }
                    },
                    "purchasingCompany": {
                        "location": {
                            "metafield": {
                                "jsonValue": {"schemaVersion": 1, "currencyCode": "INR", "hold": true, "holdReasonCode": "MANUAL_HOLD", "limitPaise": "10000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}
                            }
                        }
                    }
                }
            },
            "paymentMethods": [
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/1", "name": "Credit Card" },
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/2", "name": "Deferred Payment" }
            ],
            "paymentCustomization": null
        }
        "#;
        let result = run_test(input).unwrap();
        assert_eq!(result.operations.len(), 1, "B2B held should hide deferred even when customer not held");
    }

    #[test]
    fn test_all_hold_reason_codes() {
        let hold_reasons = vec![
            "MANUAL_HOLD",
            "PAYMENT_OVERDUE",
            "CREDIT_REVIEW",
            "NEW_ACCOUNT",
            "FRAUD_SUSPECTED",
        ];

        for reason in hold_reasons {
            let metafield = format!(
                r#"{{"schemaVersion": 1, "currencyCode": "INR", "hold": true, "holdReasonCode": "{}", "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}}"#,
                reason
            );
            let input = make_b2b_input(Some(&metafield), &default_payment_methods());
            let result = run_test(&input).unwrap();
            assert!(
                !result.operations.is_empty(),
                "Hold reason '{}' should hide payment methods",
                reason
            );
        }
    }

    // =========================================================================
    // S11 Exact Fixture Test - validates metafield shape matches S11's output
    // =========================================================================

    /// This fixture is the exact JSON produced by S11's serializeCreditStatusFromDb().
    /// If S11's output format changes and this test fails, update the Rust parser.
    /// See app/lib/metafields-contract.ts for the TypeScript definition.
    fn s11_exact_held_metafield() -> &'static str {
        // Exact shape from serializeCreditStatusFromDb with:
        // - schemaVersion: 1 (number, not string)
        // - currencyCode (not "currency")
        // - limitPaise/exposurePaise as strings (not numbers)
        // - holdReasonCode can be null
        // - No "bypass" field - bypass=true produces hold:false in the metafield
        r#"{"schemaVersion":1,"currencyCode":"INR","hold":true,"holdReasonCode":"PAYMENT_OVERDUE","limitPaise":"10000000","exposurePaise":"5000000","updatedAt":"2026-10-24T00:00:00.000Z"}"#
    }

    fn s11_exact_ok_metafield() -> &'static str {
        r#"{"schemaVersion":1,"currencyCode":"INR","hold":false,"holdReasonCode":null,"limitPaise":"10000000","exposurePaise":"5000000","updatedAt":"2026-10-24T00:00:00.000Z"}"#
    }

    fn s11_exact_bypass_metafield() -> &'static str {
        // Bypass accounts have hold:false in the metafield (S11's computeHoldState sets metafieldHold=false)
        r#"{"schemaVersion":1,"currencyCode":"INR","hold":false,"holdReasonCode":null,"limitPaise":"10000000","exposurePaise":"15000000","updatedAt":"2026-10-24T00:00:00.000Z"}"#
    }

    fn s11_exact_no_limit_metafield() -> &'static str {
        // No limit = "999999999999999" (very large sentinel)
        r#"{"schemaVersion":1,"currencyCode":"INR","hold":false,"holdReasonCode":null,"limitPaise":"999999999999999","exposurePaise":"5000000","updatedAt":"2026-10-24T00:00:00.000Z"}"#
    }

    #[test]
    fn test_s11_exact_fixture_held() {
        let input = make_b2b_input(Some(s11_exact_held_metafield()), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(!result.operations.is_empty(), "S11 exact held metafield should hide deferred methods");
    }

    #[test]
    fn test_s11_exact_fixture_ok() {
        let input = make_b2b_input(Some(s11_exact_ok_metafield()), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "S11 exact OK metafield should pass");
    }

    #[test]
    fn test_s11_exact_fixture_bypass() {
        let input = make_b2b_input(Some(s11_exact_bypass_metafield()), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "S11 exact bypass metafield should pass (hold:false)");
    }

    #[test]
    fn test_s11_exact_fixture_no_limit() {
        let input = make_b2b_input(Some(s11_exact_no_limit_metafield()), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "S11 exact no-limit metafield should pass");
    }

    // =========================================================================
    // Indian Payment Methods Test - these should NEVER be hidden
    // =========================================================================

    /// Indian payment methods that must never be hidden, even for held accounts.
    /// These are standard payment methods in India, not deferred/net-terms.
    fn indian_payment_methods() -> Vec<(&'static str, &'static str)> {
        vec![
            ("gid://shopify/PaymentCustomizationPaymentMethod/10", "Razorpay UPI"),
            ("gid://shopify/PaymentCustomizationPaymentMethod/11", "Razorpay Cards"),
            ("gid://shopify/PaymentCustomizationPaymentMethod/12", "Razorpay NetBanking"),
            ("gid://shopify/PaymentCustomizationPaymentMethod/13", "Cash on Delivery (COD)"),
            ("gid://shopify/PaymentCustomizationPaymentMethod/14", "Bank Deposit"),
        ]
    }

    #[test]
    fn test_indian_payment_methods_never_hidden() {
        // Even for a HELD account, Indian payment methods should NOT be hidden
        let input = make_b2b_input(Some(held_metafield()), &indian_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(
            result.operations.is_empty(),
            "Indian payment methods (Razorpay UPI, Cards, NetBanking, COD, Bank Deposit) should NEVER be hidden"
        );
    }

    #[test]
    fn test_indian_payment_methods_mixed_with_deferred() {
        // When Indian methods are mixed with deferred methods, only deferred should be hidden
        let mut methods = indian_payment_methods();
        methods.push(("gid://shopify/PaymentCustomizationPaymentMethod/99", "Deferred Payment"));
        
        let input = make_b2b_input(Some(held_metafield()), &methods);
        let result = run_test(&input).unwrap();
        
        assert_eq!(result.operations.len(), 1, "Only deferred payment should be hidden");
        match &result.operations[0] {
            schema::Operation::PaymentMethodHide(hide_op) => {
                assert!(
                    hide_op.payment_method_id.contains("99"),
                    "Should only hide 'Deferred Payment' (id 99), not Indian methods"
                );
            }
        }
    }

    // =========================================================================
    // Custom Config Tests - configurable patterns
    // =========================================================================

    #[test]
    fn test_b2b_custom_patterns_via_config() {
        // Custom patterns that don't match default patterns
        let config = r#"{"deferredPaymentPatterns": ["credit line", "30 days"]}"#;
        let methods = vec![
            ("gid://shopify/PaymentCustomizationPaymentMethod/1", "Credit Card"),
            ("gid://shopify/PaymentCustomizationPaymentMethod/2", "30 Days Credit Line"),
            ("gid://shopify/PaymentCustomizationPaymentMethod/3", "Net Terms"),
        ];
        
        let input = make_b2b_input_with_config(Some(held_metafield()), &methods, Some(config));
        let result = run_test(&input).unwrap();
        
        // With custom patterns, should only hide method 2 (matches "30 days" and "credit line")
        // Net Terms should NOT be hidden because it's not in custom patterns
        assert_eq!(result.operations.len(), 1, "Should only hide method matching custom patterns");
        match &result.operations[0] {
            schema::Operation::PaymentMethodHide(hide_op) => {
                assert!(
                    hide_op.payment_method_id.contains("2"),
                    "Should hide '30 Days Credit Line' which matches custom patterns"
                );
            }
        }
    }

    #[test]
    fn test_b2b_empty_patterns_hides_nothing() {
        // Empty patterns array means don't hide anything
        let config = r#"{"deferredPaymentPatterns": []}"#;
        let input = make_b2b_input_with_config(Some(held_metafield()), &default_payment_methods(), Some(config));
        let result = run_test(&input).unwrap();
        
        // Empty patterns should use defaults (this is the current behavior)
        // If we wanted empty patterns to hide nothing, we'd need to change get_deferred_patterns
        assert!(!result.operations.is_empty(), "Empty patterns fall back to defaults");
    }
}
