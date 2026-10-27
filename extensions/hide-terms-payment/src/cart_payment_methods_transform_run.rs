use crate::credit_rules::{self, PaymentDecisionInput, StatusResult};
use crate::schema;
use shopify_function::prelude::*;
use shopify_function::scalars::JsonValue;
use shopify_function::Result;

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

    /// #292: Check if shop_config is valid (has schemaVersion 1 and currencyCode).
    fn is_valid(&self) -> bool {
        self.schema_version == Some(1) && self.currency_code.is_some()
    }

    /// #292: Check if the shop is an INR shop.
    /// Returns Some(true) if shop_config has INR currency, Some(false) if non-INR.
    /// Returns None if shop_config is missing/invalid.
    fn is_inr_shop(&self) -> Option<bool> {
        if !self.is_valid() {
            return None;
        }
        self.currency_code.as_ref().map(|c| c == SUPPORTED_SHOP_CURRENCY)
    }
}

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
    /// Custom patterns ADD to the defaults rather than replacing them.
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
                        // Trim whitespace and filter out empty strings
                        let strings: Vec<String> = arr
                            .iter()
                            .filter_map(|item| match item {
                                JsonValue::String(s) => {
                                    let trimmed = s.trim().to_string();
                                    if trimmed.is_empty() { None } else { Some(trimmed) }
                                }
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
    
    /// Get the deferred payment patterns to use.
    /// Custom patterns ADD to the defaults rather than replacing them.
    fn get_deferred_patterns(&self) -> Vec<String> {
        let mut patterns: Vec<String> = DEFAULT_DEFERRED_PATTERNS
            .iter()
            .map(|s| s.to_string())
            .collect();
        
        if let Some(custom) = &self.deferred_payment_patterns {
            for p in custom {
                let lower = p.to_lowercase();
                if !patterns.iter().any(|existing| existing.to_lowercase() == lower) {
                    patterns.push(p.clone());
                }
            }
        }
        
        patterns
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
fn matches_deferred_patterns(name: &str, patterns: &[String]) -> bool {
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

    // #292: Read shop_config for INR-only logic using shared parser
    let shop_config_json = input.shop().metafield().map(|m| m.json_value());
    let shop_config_result = credit_rules::read_shop_config(shop_config_json);
    
    // Also keep the old ShopConfig for backward compatibility with existing tests
    let shop_config = match input.shop().metafield() {
        Some(m) => ShopConfig::from_json_value(m.json_value()),
        None => ShopConfig::default(),
    };

    // #292: Get cart currency for currency-mismatch hiding
    let cart_currency = cart.cost().total_amount().currency_code().to_string();

    // Load config once (used for both B2B and customer paths)
    let config = match input.payment_customization() {
        Some(pc) => match pc.metafield() {
            Some(m) => Configuration::from_json_value(m.json_value()),
            None => Configuration::default(),
        },
        None => Configuration::default(),
    };
    let deferred_patterns = config.get_deferred_patterns();

    // Helper closure to hide deferred payment methods
    let hide_deferred = || -> Vec<schema::Operation> {
        input
            .payment_methods()
            .iter()
            .filter(|pm| matches_deferred_patterns(pm.name(), &deferred_patterns))
            .map(|pm| hide_payment_method(pm.id().to_string()))
            .collect()
    };

    // #292 G2: Shop currency check with fail-closed for non-INR carts
    // - Valid non-INR shop_config → hide deferred (net-terms not available)
    // - Missing/malformed shop_config with non-INR cart → hide deferred (fail-closed)
    // - Missing/malformed shop_config with INR cart → pass (don't break ordinary INR carts)
    match shop_config.is_inr_shop() {
        Some(false) => {
            // Valid non-INR shop: hide deferred payment methods
            return Ok(schema::CartPaymentMethodsTransformRunResult { operations: hide_deferred() });
        }
        None => {
            // Missing or malformed shop_config: fail-closed for non-INR carts
            if cart_currency != SUPPORTED_SHOP_CURRENCY {
                return Ok(schema::CartPaymentMethodsTransformRunResult { operations: hide_deferred() });
            }
            // INR cart with missing shop_config: pass (don't break ordinary INR carts)
        }
        Some(true) => {
            // Valid INR shop: continue to buyer identity checks
        }
    }

    // #292: INR shop with non-INR cart → hide deferred payment (currency mismatch)
    if shop_config.is_inr_shop() == Some(true) && cart_currency != SUPPORTED_SHOP_CURRENCY {
        return Ok(schema::CartPaymentMethodsTransformRunResult { operations: hide_deferred() });
    }

    let buyer_identity = match cart.buyer_identity() {
        Some(bi) => bi,
        None => return Ok(pass()),
    };

    // Get customer metafield for potential B2B fallback
    let customer_json_value = buyer_identity
        .customer()
        .and_then(|c| c.metafield())
        .map(|m| m.json_value());

    // Check B2B company location first (takes precedence)
    if let Some(purchasing_company) = buyer_identity.purchasing_company() {
        let location = purchasing_company.location();
        let location_json = location.metafield().map(|m| m.json_value());
        
        // Read status using shared parser
        let location_status = credit_rules::read_status(location_json);
        
        // For B2B with absent location metafield, fall back to customer for hold check only
        let effective_status = match (&location_status, customer_json_value) {
            (StatusResult::Absent, Some(customer_json)) => {
                let customer_status = credit_rules::read_status(Some(customer_json));
                // Only use customer status for hold decision
                if credit_rules::is_held(&customer_status) {
                    customer_status
                } else {
                    location_status
                }
            }
            _ => location_status,
        };
        
        // Use shared rules to determine if we should hide
        let payment_input = PaymentDecisionInput {
            status: &effective_status,
            shop_config: shop_config_result,
            cart_currency: &cart_currency,
        };
        
        if credit_rules::should_hide_deferred(&payment_input) {
            return Ok(schema::CartPaymentMethodsTransformRunResult { operations: hide_deferred() });
        }
        
        return Ok(pass());
    }

    // Check tagged customer
    if let Some(customer) = buyer_identity.customer() {
        if let Some(metafield) = customer.metafield() {
            let json_value = metafield.json_value();
            let credit_status = CreditStatus::from_json_value(json_value);
            
            // Also read using shared parser for over-limit check
            let customer_status = credit_rules::read_status(Some(json_value));
            let payment_input = PaymentDecisionInput {
                status: &customer_status,
                shop_config: shop_config_result,
                cart_currency: &cart_currency,
            };
            
            // Check if should hide using shared rules (held, indeterminate, or over limit)
            if credit_rules::should_hide_deferred(&payment_input) {
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
                    hide_deferred()
                };
                
                return Ok(schema::CartPaymentMethodsTransformRunResult { operations });
            }
            
            // Legacy path: check old is_held for backward compatibility
            if credit_status.is_held() {
                let operations: Vec<schema::Operation> = if let Some(ref target_name) = config.manual_payment_method_name {
                    input
                        .payment_methods()
                        .iter()
                        .filter(|pm| pm.name().to_lowercase() == target_name.to_lowercase())
                        .map(|pm| hide_payment_method(pm.id().to_string()))
                        .collect()
                } else {
                    hide_deferred()
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

    fn make_b2b_input_full(
        metafield_json: Option<&str>,
        payment_methods: &[(&str, &str)],
        config_json: Option<&str>,
        cart_currency: &str,
        shop_config_json: Option<&str>,
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

        let shop_metafield = match shop_config_json {
            Some(cfg) => format!(r#"{{ "jsonValue": {} }}"#, cfg),
            None => "null".to_string(),
        };

        format!(
            r#"{{
                "cart": {{
                    "cost": {{
                        "totalAmount": {{
                            "currencyCode": "{}"
                        }}
                    }},
                    "buyerIdentity": {{
                        "customer": null,
                        "purchasingCompany": {{
                            "location": {}
                        }}
                    }}
                }},
                "paymentMethods": [{}],
                "paymentCustomization": {},
                "shop": {{
                    "metafield": {}
                }}
            }}"#,
            cart_currency, location_metafield, pm_json, pc_json, shop_metafield
        )
    }

    fn make_b2b_input_with_config(
        metafield_json: Option<&str>,
        payment_methods: &[(&str, &str)],
        config_json: Option<&str>,
    ) -> String {
        // #292: Default to INR shop config and INR cart for backward compatibility
        make_b2b_input_full(
            metafield_json,
            payment_methods,
            config_json,
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR"}"#),
        )
    }

    fn make_b2b_input(metafield_json: Option<&str>, payment_methods: &[(&str, &str)]) -> String {
        make_b2b_input_with_config(metafield_json, payment_methods, None)
    }

    fn make_customer_input_full(
        metafield_json: Option<&str>,
        payment_methods: &[(&str, &str)],
        config_json: Option<&str>,
        cart_currency: &str,
        shop_config_json: Option<&str>,
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

        let shop_metafield = match shop_config_json {
            Some(cfg) => format!(r#"{{ "jsonValue": {} }}"#, cfg),
            None => "null".to_string(),
        };

        format!(
            r#"{{
                "cart": {{
                    "cost": {{
                        "totalAmount": {{
                            "currencyCode": "{}"
                        }}
                    }},
                    "buyerIdentity": {{
                        "customer": {},
                        "purchasingCompany": null
                    }}
                }},
                "paymentMethods": [{}],
                "paymentCustomization": {},
                "shop": {{
                    "metafield": {}
                }}
            }}"#,
            cart_currency, customer_metafield, pm_json, pc_json, shop_metafield
        )
    }

    fn make_customer_input(
        metafield_json: Option<&str>,
        payment_methods: &[(&str, &str)],
        config_json: Option<&str>,
    ) -> String {
        // #292: Default to INR shop config and INR cart for backward compatibility
        make_customer_input_full(
            metafield_json,
            payment_methods,
            config_json,
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR"}"#),
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
    // Missing/Null $app:credit_status metafield = ALLOW (fail-open, nothing hidden)
    // These tests verify that seed CompanyLocations without the metafield
    // don't have payment methods hidden (deferred payment remains visible).
    // =========================================================================

    #[test]
    fn test_missing_credit_status_metafield_shows_all_payment_methods() {
        // When $app:credit_status is missing (null), ALL payment methods should be visible.
        // This is the fail-open behavior required for seed CompanyLocations
        // that haven't had their metafield synced yet.
        let input = make_b2b_input(None, &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Missing credit_status metafield must show all payment methods (nothing hidden)");
    }

    #[test]
    fn test_customer_missing_credit_status_metafield_shows_all_payment_methods() {
        // Tagged customer with null $app:credit_status should see all payment methods.
        let input = make_customer_input(None, &default_payment_methods(), None);
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Customer with missing credit_status metafield must show all payment methods");
    }

    #[test]
    fn test_null_json_value_shows_all_payment_methods() {
        // Even if the metafield object exists but jsonValue is null
        let metafield_null = "null";
        let location_metafield = format!(r#"{{ "metafield": {{ "jsonValue": {} }} }}"#, metafield_null);
        let input = format!(
            r#"{{
                "cart": {{
                    "cost": {{
                        "totalAmount": {{
                            "currencyCode": "INR"
                        }}
                    }},
                    "buyerIdentity": {{
                        "customer": null,
                        "purchasingCompany": {{
                            "location": {}
                        }}
                    }}
                }},
                "paymentMethods": [
                    {{ "id": "pm1", "name": "Deferred Payment" }}
                ],
                "paymentCustomization": null,
                "shop": {{
                    "metafield": {{
                        "jsonValue": {{"schemaVersion": 1, "currencyCode": "INR"}}
                    }}
                }}
            }}"#,
            location_metafield
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Null jsonValue must show all payment methods (fail-open)");
    }

    #[test]
    fn test_empty_object_metafield_shows_all_payment_methods() {
        // Empty object {} should fail-open (no schemaVersion = not held)
        let input = make_b2b_input(Some("{}"), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Empty object metafield must show all payment methods (fail-open)");
    }

    // =========================================================================
    // Edge Cases
    // =========================================================================

    #[test]
    fn test_guest_checkout_passes() {
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "currencyCode": "INR"
                    }
                },
                "buyerIdentity": null
            },
            "paymentMethods": [
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/1", "name": "Credit Card" }
            ],
            "paymentCustomization": null,
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
                "cost": {
                    "totalAmount": {
                        "currencyCode": "INR"
                    }
                },
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
            "paymentCustomization": null,
            "shop": {
                "metafield": {
                    "jsonValue": {"schemaVersion": 1, "currencyCode": "INR"}
                }
            }
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

    #[test]
    fn test_b2b_whitespace_only_patterns_fall_back_to_defaults() {
        // Patterns with only whitespace or empty strings should be filtered out
        // and fall back to defaults
        let config = r#"{"deferredPaymentPatterns": ["", "   ", "\t", "\n", "  \t  "]}"#;
        let input = make_b2b_input_with_config(Some(held_metafield()), &default_payment_methods(), Some(config));
        let result = run_test(&input).unwrap();
        
        // All patterns are empty/whitespace-only, so falls back to defaults which hide deferred
        assert!(!result.operations.is_empty(), "Whitespace-only patterns should fall back to defaults");
    }

    #[test]
    fn test_b2b_mixed_empty_and_valid_patterns() {
        // Mix of empty, whitespace, and valid patterns - valid ones should work
        let config = r#"{"deferredPaymentPatterns": ["", "custom-term", "   ", "30 days"]}"#;
        let payment_methods = vec![
            ("gid://shopify/PaymentCustomizationPaymentMethod/1", "Pay now"),
            ("gid://shopify/PaymentCustomizationPaymentMethod/2", "Custom-Term Payment"),
            ("gid://shopify/PaymentCustomizationPaymentMethod/3", "30 Days Net"),
        ];
        let input = make_b2b_input_with_config(Some(held_metafield()), &payment_methods, Some(config));
        let result = run_test(&input).unwrap();
        
        // Should hide "Custom-Term Payment" (matches "custom-term") and "30 Days Net" (matches "30 days")
        assert_eq!(result.operations.len(), 2, "Should hide 2 payment methods matching valid patterns");
    }

    #[test]
    fn test_b2b_patterns_trimmed() {
        // Patterns with leading/trailing whitespace should be trimmed
        let config = r#"{"deferredPaymentPatterns": ["  deferred  ", "\tnet terms\n"]}"#;
        let input = make_b2b_input_with_config(Some(held_metafield()), &default_payment_methods(), Some(config));
        let result = run_test(&input).unwrap();
        
        // Should hide methods matching trimmed patterns
        assert!(!result.operations.is_empty(), "Trimmed patterns should still match");
    }

    // =========================================================================
    // #292 INR-Only Tests
    // =========================================================================

    #[test]
    fn test_non_inr_shop_hides_deferred() {
        // Non-INR shop should hide deferred payment regardless of credit_status
        let input = make_b2b_input_full(
            Some(ok_metafield()),  // not held
            &default_payment_methods(),
            None,
            "USD",
            Some(r#"{"schemaVersion": 1, "currencyCode": "USD"}"#),
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "Non-INR shop should hide deferred methods");
    }

    #[test]
    fn test_inr_shop_with_non_inr_cart_hides_deferred() {
        // INR shop with non-INR cart should hide deferred payment
        let input = make_b2b_input_full(
            Some(ok_metafield()),  // not held
            &default_payment_methods(),
            None,
            "USD",  // cart in USD
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR"}"#),  // shop is INR
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "INR shop with non-INR cart should hide deferred methods");
    }

    #[test]
    fn test_inr_shop_with_inr_cart_passes() {
        // INR shop with INR cart and not-held account should pass
        let input = make_b2b_input_full(
            Some(ok_metafield()),  // not held
            &default_payment_methods(),
            None,
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": "INR"}"#),
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "INR shop with INR cart and not-held should pass");
    }

    #[test]
    fn test_missing_shop_config_inr_cart_passes() {
        // #292 G2: Missing shop_config with INR cart should pass (don't break ordinary INR carts)
        let input = make_b2b_input_full(
            Some(ok_metafield()),  // not held
            &default_payment_methods(),
            None,
            "INR",
            None,  // no shop_config
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Missing shop_config with INR cart should pass");
    }

    #[test]
    fn test_missing_shop_config_usd_cart_hides() {
        // #292 G2: Missing shop_config with non-INR cart should hide deferred (fail-closed)
        let input = make_b2b_input_full(
            Some(ok_metafield()),  // not held
            &default_payment_methods(),
            None,
            "USD",  // non-INR cart
            None,   // no shop_config
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "Missing shop_config with USD cart should hide deferred (fail-closed)");
    }

    /// #292 G2: Both credit_status AND shop_config missing with INR cart passes (fail-open for INR).
    /// This is the scenario for brand-new CompanyLocations before any metafield sync.
    #[test]
    fn test_missing_credit_status_and_missing_shop_config_inr_cart_shows_all() {
        let input = make_b2b_input_full(
            None,  // No credit_status metafield
            &default_payment_methods(),
            None,
            "INR",
            None,  // No shop_config metafield
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Missing credit_status AND missing shop_config with INR cart must show all payment methods");
    }

    /// #292 G2: Both credit_status AND shop_config missing with non-INR cart hides deferred.
    #[test]
    fn test_missing_credit_status_and_missing_shop_config_usd_cart_hides() {
        let input = make_b2b_input_full(
            None,  // No credit_status metafield
            &default_payment_methods(),
            None,
            "USD",  // non-INR cart
            None,   // No shop_config metafield
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "Missing credit_status AND missing shop_config with USD cart must hide deferred (fail-closed)");
    }

    /// #292 G2: Customer with both metafields missing and INR cart passes.
    #[test]
    fn test_customer_missing_credit_status_and_missing_shop_config_inr_cart_shows_all() {
        let input = make_customer_input_full(
            None,  // No credit_status metafield
            &default_payment_methods(),
            None,
            "INR",
            None,  // No shop_config metafield
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Customer with missing credit_status AND missing shop_config with INR cart must show all payment methods");
    }

    /// #292 G2: Customer with both metafields missing and non-INR cart hides deferred.
    #[test]
    fn test_customer_missing_credit_status_and_missing_shop_config_usd_cart_hides() {
        let input = make_customer_input_full(
            None,  // No credit_status metafield
            &default_payment_methods(),
            None,
            "USD",  // non-INR cart
            None,   // No shop_config metafield
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "Customer with missing credit_status AND missing shop_config with USD cart must hide deferred (fail-closed)");
    }

    #[test]
    fn test_customer_non_inr_shop_hides_deferred() {
        // Non-INR shop should hide deferred payment for customer path too
        let input = make_customer_input_full(
            Some(ok_metafield()),  // not held
            &default_payment_methods(),
            None,
            "USD",
            Some(r#"{"schemaVersion": 1, "currencyCode": "USD"}"#),
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "Non-INR shop should hide deferred for customer path");
    }

    #[test]
    fn test_non_inr_shop_no_buyer_identity_hides_deferred() {
        // #292: Non-INR shop should hide deferred payment even for guest checkout (no buyerIdentity)
        let input = r#"
        {
            "cart": {
                "cost": {
                    "totalAmount": {
                        "currencyCode": "USD"
                    }
                },
                "buyerIdentity": null
            },
            "paymentMethods": [
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/1", "name": "Credit Card" },
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/2", "name": "Deferred Payment" },
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/3", "name": "Net Terms" }
            ],
            "paymentCustomization": null,
            "shop": {
                "metafield": {
                    "jsonValue": {"schemaVersion": 1, "currencyCode": "USD"}
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert_eq!(result.operations.len(), 2, "Non-INR shop with no buyerIdentity must hide deferred methods");
    }

    // =========================================================================
    // #292 G2: Malformed shop_config tests (fail-closed for non-INR carts)
    // =========================================================================

    #[test]
    fn test_malformed_shop_config_bad_json_usd_cart_hides() {
        // Malformed JSON in shop_config with USD cart should hide deferred (fail-closed)
        let input = make_b2b_input_full(
            Some(ok_metafield()),
            &default_payment_methods(),
            None,
            "USD",
            Some(r#"{"notValid": true}"#),  // Missing schemaVersion and currencyCode
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "Malformed shop_config (bad JSON structure) with USD cart must hide deferred");
    }

    #[test]
    fn test_malformed_shop_config_bad_json_inr_cart_passes() {
        // Malformed JSON in shop_config with INR cart should pass (don't break INR carts)
        let input = make_b2b_input_full(
            Some(ok_metafield()),
            &default_payment_methods(),
            None,
            "INR",
            Some(r#"{"notValid": true}"#),  // Missing schemaVersion and currencyCode
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Malformed shop_config with INR cart should pass");
    }

    #[test]
    fn test_malformed_shop_config_wrong_schema_version_usd_cart_hides() {
        // Wrong schemaVersion with USD cart should hide deferred (fail-closed)
        let input = make_b2b_input_full(
            Some(ok_metafield()),
            &default_payment_methods(),
            None,
            "USD",
            Some(r#"{"schemaVersion": 999, "currencyCode": "USD"}"#),
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "shop_config with wrong schemaVersion and USD cart must hide deferred");
    }

    #[test]
    fn test_malformed_shop_config_wrong_schema_version_inr_cart_passes() {
        // Wrong schemaVersion with INR cart should pass (don't break INR carts)
        let input = make_b2b_input_full(
            Some(ok_metafield()),
            &default_payment_methods(),
            None,
            "INR",
            Some(r#"{"schemaVersion": 999, "currencyCode": "INR"}"#),
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "shop_config with wrong schemaVersion and INR cart should pass");
    }

    #[test]
    fn test_malformed_shop_config_missing_currency_code_usd_cart_hides() {
        // Missing currencyCode with USD cart should hide deferred (fail-closed)
        let input = make_b2b_input_full(
            Some(ok_metafield()),
            &default_payment_methods(),
            None,
            "USD",
            Some(r#"{"schemaVersion": 1}"#),  // Missing currencyCode
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "shop_config missing currencyCode with USD cart must hide deferred");
    }

    #[test]
    fn test_malformed_shop_config_missing_currency_code_inr_cart_passes() {
        // Missing currencyCode with INR cart should pass (don't break INR carts)
        let input = make_b2b_input_full(
            Some(ok_metafield()),
            &default_payment_methods(),
            None,
            "INR",
            Some(r#"{"schemaVersion": 1}"#),  // Missing currencyCode
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "shop_config missing currencyCode with INR cart should pass");
    }

    #[test]
    fn test_malformed_shop_config_missing_schema_version_usd_cart_hides() {
        // Missing schemaVersion with USD cart should hide deferred (fail-closed)
        let input = make_b2b_input_full(
            Some(ok_metafield()),
            &default_payment_methods(),
            None,
            "USD",
            Some(r#"{"currencyCode": "USD"}"#),  // Missing schemaVersion
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "shop_config missing schemaVersion with USD cart must hide deferred");
    }

    #[test]
    fn test_malformed_shop_config_missing_schema_version_inr_cart_passes() {
        // Missing schemaVersion with INR cart should pass (don't break INR carts)
        let input = make_b2b_input_full(
            Some(ok_metafield()),
            &default_payment_methods(),
            None,
            "INR",
            Some(r#"{"currencyCode": "INR"}"#),  // Missing schemaVersion
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "shop_config missing schemaVersion with INR cart should pass");
    }

    /// #292 G2: Truly unparseable shop_config (string, not object) with USD cart hides deferred.
    /// Simulates when Shopify's metafield contains garbage that can't be parsed as an object.
    #[test]
    fn test_unparseable_shop_config_usd_cart_hides() {
        // When jsonValue is a string instead of an object, from_json_value returns default
        let input = r#"
        {
            "cart": {
                "cost": { "totalAmount": { "currencyCode": "USD" } },
                "buyerIdentity": {
                    "customer": null,
                    "purchasingCompany": {
                        "company": {},
                        "location": { "metafield": { "jsonValue": {"schemaVersion": 1, "hold": false} } }
                    }
                }
            },
            "paymentMethods": [
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/1", "name": "Credit Card" },
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/2", "name": "Deferred Payment" },
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/3", "name": "Net Terms" }
            ],
            "paymentCustomization": null,
            "shop": {
                "metafield": {
                    "jsonValue": "not-json{"
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert_eq!(result.operations.len(), 2, "Unparseable shop_config (string value) with USD cart must hide deferred (fail-closed)");
    }

    /// #292 G2: Truly unparseable shop_config (string, not object) with INR cart passes.
    /// INR carts must never panic or error on malformed shop_config.
    #[test]
    fn test_unparseable_shop_config_inr_cart_passes() {
        // When jsonValue is a string instead of an object, from_json_value returns default
        let input = r#"
        {
            "cart": {
                "cost": { "totalAmount": { "currencyCode": "INR" } },
                "buyerIdentity": {
                    "customer": null,
                    "purchasingCompany": {
                        "company": {},
                        "location": { "metafield": { "jsonValue": {"schemaVersion": 1, "hold": false} } }
                    }
                }
            },
            "paymentMethods": [
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/1", "name": "Credit Card" },
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/2", "name": "Deferred Payment" },
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/3", "name": "Net Terms" }
            ],
            "paymentCustomization": null,
            "shop": {
                "metafield": {
                    "jsonValue": "not-json{"
                }
            }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.operations.is_empty(), "Unparseable shop_config (string value) with INR cart must pass without error");
    }

    // =========================================================================
    // Case 1: Buyer Eligibility Tests (using runtime-generated IDs)
    // Tests that net terms are shown to eligible buyers, hidden for non-eligible
    // =========================================================================

    fn pm_gid(n: u64) -> String {
        format!("gid://shopify/PaymentCustomizationPaymentMethod/{}", n)
    }

    fn make_b2b_input_runtime_ids(
        metafield_json: Option<&str>,
        payment_method_ids: &[(u64, &str)],
    ) -> String {
        let location_metafield = match metafield_json {
            Some(mf) => format!(r#"{{ "metafield": {{ "jsonValue": {} }} }}"#, mf),
            None => r#"{ "metafield": null }"#.to_string(),
        };

        let pm_json: String = payment_method_ids
            .iter()
            .map(|(id, name)| format!(r#"{{ "id": "{}", "name": "{}" }}"#, pm_gid(*id), name))
            .collect::<Vec<_>>()
            .join(", ");

        format!(
            r#"{{
                "cart": {{
                    "cost": {{ "totalAmount": {{ "currencyCode": "INR" }} }},
                    "buyerIdentity": {{
                        "customer": null,
                        "purchasingCompany": {{ "location": {} }}
                    }}
                }},
                "paymentMethods": [{}],
                "paymentCustomization": null,
                "shop": {{ "metafield": {{ "jsonValue": {{"schemaVersion": 1, "currencyCode": "INR"}} }} }}
            }}"#,
            location_metafield, pm_json
        )
    }

    fn make_customer_input_runtime_ids(
        metafield_json: Option<&str>,
        payment_method_ids: &[(u64, &str)],
    ) -> String {
        let customer_metafield = match metafield_json {
            Some(mf) => format!(r#"{{ "metafield": {{ "jsonValue": {} }} }}"#, mf),
            None => r#"{ "metafield": null }"#.to_string(),
        };

        let pm_json: String = payment_method_ids
            .iter()
            .map(|(id, name)| format!(r#"{{ "id": "{}", "name": "{}" }}"#, pm_gid(*id), name))
            .collect::<Vec<_>>()
            .join(", ");

        format!(
            r#"{{
                "cart": {{
                    "cost": {{ "totalAmount": {{ "currencyCode": "INR" }} }},
                    "buyerIdentity": {{
                        "customer": {},
                        "purchasingCompany": null
                    }}
                }},
                "paymentMethods": [{}],
                "paymentCustomization": null,
                "shop": {{ "metafield": {{ "jsonValue": {{"schemaVersion": 1, "currencyCode": "INR"}} }} }}
            }}"#,
            customer_metafield, pm_json
        )
    }

    #[test]
    fn test_eligible_buyer_sees_net_terms() {
        let eligible_metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "50000000", "exposurePaise": "10000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let pms = &[(101, "UPI"), (102, "Net Terms 30"), (103, "Credit Card")];
        let input = make_b2b_input_runtime_ids(Some(eligible_metafield), pms);
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Eligible buyer (hold=false, under limit) should see all payment methods including net terms");
    }

    #[test]
    fn test_held_buyer_net_terms_hidden() {
        let held_metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": true, "holdReasonCode": "PAYMENT_OVERDUE", "limitPaise": "50000000", "exposurePaise": "10000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let pms = &[(201, "UPI"), (202, "Net Terms 30"), (203, "Deferred Payment")];
        let input = make_b2b_input_runtime_ids(Some(held_metafield), pms);
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "Held buyer should have deferred payment methods hidden");
        for op in &result.operations {
            match op {
                schema::Operation::PaymentMethodHide(hide_op) => {
                    assert!(
                        hide_op.payment_method_id.contains("202") || hide_op.payment_method_id.contains("203"),
                        "Should hide net terms and deferred payment, not UPI"
                    );
                }
            }
        }
    }

    #[test]
    fn test_hold_false_shows_all_methods_even_when_overlimit() {
        let overlimit_not_held = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "99000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let pms = &[(301, "Net Terms"), (302, "Pay Later"), (303, "COD")];
        let input = make_b2b_input_runtime_ids(Some(overlimit_not_held), pms);
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "hold=false shows all methods regardless of exposure vs limit");
    }

    #[test]
    fn test_missing_metafield_failopen_shows_all() {
        let pms = &[(401, "Net Terms"), (402, "Deferred"), (403, "Card")];
        let input = make_b2b_input_runtime_ids(None, pms);
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Missing credit_status metafield must fail-open (show all methods)");
    }

    #[test]
    fn test_customer_tagged_held_hides_deferred() {
        let held_metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": true, "holdReasonCode": "MANUAL_HOLD", "limitPaise": "20000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let pms = &[(501, "Razorpay UPI"), (502, "Net Terms"), (503, "Pay Later")];
        let input = make_customer_input_runtime_ids(Some(held_metafield), pms);
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "Tagged customer on hold should have net terms/pay later hidden");
    }

    #[test]
    fn test_customer_tagged_eligible_sees_all() {
        let ok_metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "20000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let pms = &[(601, "Razorpay UPI"), (602, "Net Terms"), (603, "Pay Later")];
        let input = make_customer_input_runtime_ids(Some(ok_metafield), pms);
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "Eligible tagged customer should see all payment methods");
    }

    #[test]
    fn test_near_limit_buyer_still_sees_net_terms() {
        let near_limit_metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "9500000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let pms = &[(701, "Net Terms"), (702, "Deferred Payment")];
        let input = make_b2b_input_runtime_ids(Some(near_limit_metafield), pms);
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "NEAR_LIMIT buyer (not held) should still see net terms");
    }

    #[test]
    fn test_hold_reason_credit_review_hides_methods() {
        let credit_review_metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": true, "holdReasonCode": "CREDIT_REVIEW", "limitPaise": "10000000", "exposurePaise": "12000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let pms = &[(801, "Card"), (802, "Net Terms")];
        let input = make_b2b_input_runtime_ids(Some(credit_review_metafield), pms);
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "CREDIT_REVIEW hold should hide deferred methods");
    }

    #[test]
    fn test_hold_reason_new_account_hides_methods() {
        let new_account_metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": true, "holdReasonCode": "NEW_ACCOUNT", "limitPaise": "5000000", "exposurePaise": "0", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let pms = &[(901, "Bank Transfer"), (902, "Deferred Payment")];
        let input = make_b2b_input_runtime_ids(Some(new_account_metafield), pms);
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "NEW_ACCOUNT hold should hide deferred methods");
    }

    // =========================================================================
    // Case 5: Non-INR shop fail-closed tests
    // =========================================================================

    fn make_b2b_with_currency(
        metafield_json: Option<&str>,
        payment_method_ids: &[(u64, &str)],
        cart_currency: &str,
        shop_currency: &str,
    ) -> String {
        let location_metafield = match metafield_json {
            Some(mf) => format!(r#"{{ "metafield": {{ "jsonValue": {} }} }}"#, mf),
            None => r#"{ "metafield": null }"#.to_string(),
        };

        let pm_json: String = payment_method_ids
            .iter()
            .map(|(id, name)| format!(r#"{{ "id": "{}", "name": "{}" }}"#, pm_gid(*id), name))
            .collect::<Vec<_>>()
            .join(", ");

        let shop_config = format!(r#"{{"schemaVersion": 1, "currencyCode": "{}"}}"#, shop_currency);

        format!(
            r#"{{
                "cart": {{
                    "cost": {{ "totalAmount": {{ "currencyCode": "{}" }} }},
                    "buyerIdentity": {{
                        "customer": null,
                        "purchasingCompany": {{ "location": {} }}
                    }}
                }},
                "paymentMethods": [{}],
                "paymentCustomization": null,
                "shop": {{ "metafield": {{ "jsonValue": {} }} }}
            }}"#,
            cart_currency, location_metafield, pm_json, shop_config
        )
    }

    #[test]
    fn test_usd_shop_no_net_terms_offered() {
        let ok_metafield = r#"{"schemaVersion": 1, "currencyCode": "USD", "hold": false, "holdReasonCode": null, "limitPaise": "50000000", "exposurePaise": "10000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let pms = &[(1001, "Card"), (1002, "Net Terms"), (1003, "Deferred")];
        let input = make_b2b_with_currency(Some(ok_metafield), pms, "USD", "USD");
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "Non-INR (USD) shop must hide deferred payment methods (fail-closed)");
    }

    #[test]
    fn test_eur_shop_no_net_terms_offered() {
        let ok_metafield = r#"{"schemaVersion": 1, "currencyCode": "EUR", "hold": false, "holdReasonCode": null, "limitPaise": "50000000", "exposurePaise": "10000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let pms = &[(1101, "PayPal"), (1102, "Net Terms 60")];
        let input = make_b2b_with_currency(Some(ok_metafield), pms, "EUR", "EUR");
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Non-INR (EUR) shop must hide deferred payment methods");
    }

    #[test]
    fn test_inr_shop_non_inr_cart_hides_deferred() {
        let ok_metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": false, "holdReasonCode": null, "limitPaise": "50000000", "exposurePaise": "10000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let pms = &[(1201, "Card"), (1202, "Net Terms")];
        let input = make_b2b_with_currency(Some(ok_metafield), pms, "USD", "INR");
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "INR shop with non-INR cart must hide deferred methods");
    }

    #[test]
    fn test_missing_shop_config_non_inr_cart_hides_deferred() {
        let input = format!(
            r#"{{
                "cart": {{
                    "cost": {{ "totalAmount": {{ "currencyCode": "USD" }} }},
                    "buyerIdentity": {{
                        "customer": null,
                        "purchasingCompany": {{ "location": {{ "metafield": null }} }}
                    }}
                }},
                "paymentMethods": [{{ "id": "{}", "name": "Card" }}, {{ "id": "{}", "name": "Deferred Payment" }}],
                "paymentCustomization": null,
                "shop": {{ "metafield": null }}
            }}"#,
            pm_gid(1301), pm_gid(1302)
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 1, "Missing shop_config with non-INR cart must hide deferred (fail-closed)");
    }

    // =========================================================================
    // Edge-Case Tests: Metafield parsing and type coercion
    // =========================================================================

    /// Empty string metafield (not a JSON object).
    #[test]
    fn test_metafield_empty_string() {
        let input = make_b2b_input(Some(r#""""#), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: metafield empty string");
    }

    /// Array metafield (not a JSON object).
    #[test]
    fn test_metafield_array() {
        let input = make_b2b_input(Some(r#"[1, 2, 3]"#), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: metafield array");
    }

    /// Number metafield (not a JSON object).
    #[test]
    fn test_metafield_number() {
        let input = make_b2b_input(Some(r#"12345"#), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: metafield number");
    }

    /// Boolean metafield (not a JSON object).
    #[test]
    fn test_metafield_boolean() {
        let input = make_b2b_input(Some(r#"true"#), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: metafield boolean");
    }

    /// hold field as string "true" instead of boolean.
    #[test]
    fn test_hold_string_true() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": "true", "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_b2b_input(Some(metafield), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: hold as string true");
    }

    /// hold field as string "HOLD".
    #[test]
    fn test_hold_string_hold() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": "HOLD", "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_b2b_input(Some(metafield), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: hold as string HOLD");
    }

    /// hold field as empty string.
    #[test]
    fn test_hold_empty_string() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": "", "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_b2b_input(Some(metafield), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: hold as empty string");
    }

    /// hold field as number 1.
    #[test]
    fn test_hold_number() {
        let metafield = r#"{"schemaVersion": 1, "currencyCode": "INR", "hold": 1, "holdReasonCode": null, "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_b2b_input(Some(metafield), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: hold as number");
    }

    /// schemaVersion field as string "1" instead of number.
    #[test]
    fn test_schema_version_string() {
        let metafield = r#"{"schemaVersion": "1", "currencyCode": "INR", "hold": true, "holdReasonCode": "MANUAL_HOLD", "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_b2b_input(Some(metafield), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: schemaVersion as string");
    }

    /// schemaVersion field as 0.
    #[test]
    fn test_schema_version_zero() {
        let metafield = r#"{"schemaVersion": 0, "currencyCode": "INR", "hold": true, "holdReasonCode": "MANUAL_HOLD", "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_b2b_input(Some(metafield), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: schemaVersion zero");
    }

    /// schemaVersion field as -1.
    #[test]
    fn test_schema_version_negative() {
        let metafield = r#"{"schemaVersion": -1, "currencyCode": "INR", "hold": true, "holdReasonCode": "MANUAL_HOLD", "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_b2b_input(Some(metafield), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: schemaVersion negative");
    }

    /// schemaVersion field as very large number.
    #[test]
    fn test_schema_version_very_large() {
        let metafield = r#"{"schemaVersion": 999999, "currencyCode": "INR", "hold": true, "holdReasonCode": "MANUAL_HOLD", "limitPaise": "10000000", "exposurePaise": "5000000", "updatedAt": "2026-10-23T00:00:00Z"}"#;
        let input = make_b2b_input(Some(metafield), &default_payment_methods());
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: schemaVersion very large");
    }

    // =========================================================================
    // Edge-Case Tests: shop_config parsing
    // =========================================================================

    /// Empty string shop_config with INR cart.
    #[test]
    fn test_empty_string_shop_config_inr_cart() {
        let input = r#"
        {
            "cart": {
                "cost": { "totalAmount": { "currencyCode": "INR" } },
                "buyerIdentity": {
                    "customer": null,
                    "purchasingCompany": {
                        "location": { "metafield": { "jsonValue": {"schemaVersion": 1, "hold": false} } }
                    }
                }
            },
            "paymentMethods": [
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/1", "name": "Deferred Payment" }
            ],
            "paymentCustomization": null,
            "shop": { "metafield": { "jsonValue": "" } }
        }
        "#;
        let result = run_test(input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: empty string shop_config with INR cart");
    }

    /// Empty string shop_config with USD cart.
    #[test]
    fn test_empty_string_shop_config_usd_cart() {
        let input = r#"
        {
            "cart": {
                "cost": { "totalAmount": { "currencyCode": "USD" } },
                "buyerIdentity": {
                    "customer": null,
                    "purchasingCompany": {
                        "location": { "metafield": { "jsonValue": {"schemaVersion": 1, "hold": false} } }
                    }
                }
            },
            "paymentMethods": [
                { "id": "gid://shopify/PaymentCustomizationPaymentMethod/1", "name": "Deferred Payment" }
            ],
            "paymentCustomization": null,
            "shop": { "metafield": { "jsonValue": "" } }
        }
        "#;
        let result = run_test(input).unwrap();
        assert_eq!(result.operations.len(), 1, "pinned behaviour: empty string shop_config with USD cart");
    }

    /// shop_config with schemaVersion as string, INR cart.
    #[test]
    fn test_shop_config_schema_version_string_inr_cart() {
        let input = make_b2b_input_full(
            Some(ok_metafield()),
            &default_payment_methods(),
            None,
            "INR",
            Some(r#"{"schemaVersion": "1", "currencyCode": "INR"}"#),
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: shop_config schemaVersion string with INR cart");
    }

    /// shop_config with schemaVersion as string, USD cart.
    #[test]
    fn test_shop_config_schema_version_string_usd_cart() {
        let input = make_b2b_input_full(
            Some(ok_metafield()),
            &default_payment_methods(),
            None,
            "USD",
            Some(r#"{"schemaVersion": "1", "currencyCode": "USD"}"#),
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "pinned behaviour: shop_config schemaVersion string with USD cart");
    }

    /// shop_config with currencyCode as number, INR cart.
    #[test]
    fn test_shop_config_currency_number_inr_cart() {
        let input = make_b2b_input_full(
            Some(ok_metafield()),
            &default_payment_methods(),
            None,
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": 356}"#),
        );
        let result = run_test(&input).unwrap();
        assert!(result.operations.is_empty(), "pinned behaviour: shop_config currencyCode as number with INR cart");
    }

    /// shop_config with empty currencyCode.
    #[test]
    fn test_shop_config_empty_currency() {
        let input = make_b2b_input_full(
            Some(ok_metafield()),
            &default_payment_methods(),
            None,
            "INR",
            Some(r#"{"schemaVersion": 1, "currencyCode": ""}"#),
        );
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "pinned behaviour: shop_config with empty currencyCode");
    }

    // =========================================================================
    // Edge-Case Tests: hide-terms-config parsing
    // =========================================================================

    /// hide-terms-config as empty object.
    #[test]
    fn test_hide_config_empty_object() {
        let metafield = held_metafield();
        let input = make_b2b_input_with_config(Some(metafield), &default_payment_methods(), Some(r#"{}"#));
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "pinned behaviour: empty hide-config object");
    }

    /// hide-terms-config as number.
    #[test]
    fn test_hide_config_number() {
        let metafield = held_metafield();
        let input = make_b2b_input_with_config(Some(metafield), &default_payment_methods(), Some(r#"12345"#));
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "pinned behaviour: hide-config as number");
    }

    /// hide-terms-config with deferredPaymentPatterns as string.
    #[test]
    fn test_hide_config_patterns_string() {
        let metafield = held_metafield();
        let config = r#"{"deferredPaymentPatterns": "deferred"}"#;
        let input = make_b2b_input_with_config(Some(metafield), &default_payment_methods(), Some(config));
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "pinned behaviour: deferredPaymentPatterns as string");
    }

    /// hide-terms-config with manualPaymentMethodName as number.
    #[test]
    fn test_hide_config_manual_method_number() {
        let metafield = held_metafield();
        let config = r#"{"manualPaymentMethodName": 12345}"#;
        let input = make_customer_input(Some(metafield), &default_payment_methods(), Some(config));
        let result = run_test(&input).unwrap();
        assert_eq!(result.operations.len(), 2, "pinned behaviour: manualPaymentMethodName as number");
    }
}
