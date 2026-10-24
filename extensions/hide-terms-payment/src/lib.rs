use shopify_function::prelude::*;

pub mod cart_payment_methods_transform_run;

pub use cart_payment_methods_transform_run::CreditStatus;

#[typegen("./schema.graphql", enums_as_str = ["PaymentCustomizationPaymentMethodPlacement"])]
pub mod schema {
    #[query("src/cart_payment_methods_transform_run.graphql")]
    pub mod cart_payment_methods_transform_run {}
}
