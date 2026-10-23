use shopify_function::prelude::*;

pub mod run;

pub use run::CreditStatus;

#[typegen("./schema.graphql", enums_as_str = ["CurrencyCode"])]
pub mod schema {
    #[query("src/run.graphql")]
    pub mod run {}
}
