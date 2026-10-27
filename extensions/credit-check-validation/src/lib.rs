use shopify_function::prelude::*;

#[path = "../../../functions-shared/credit_rules.rs"]
pub mod credit_rules;

pub mod cart_validations_generate_run;

pub use cart_validations_generate_run::CreditStatus;

#[typegen("./schema.graphql", enums_as_str = ["CurrencyCode", "BuyerJourneyStep"])]
pub mod schema {
    #[query("src/cart_validations_generate_run.graphql")]
    pub mod cart_validations_generate_run {}
}
