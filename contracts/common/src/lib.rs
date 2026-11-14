//! Shared types and fixed-point math for the KYP contracts.
//!
//! Everything here is pure (no storage, no promises) so it can be unit tested
//! directly and reused by the coordinator, the lock and the mock pool.

pub mod dcl;
pub mod math;
pub mod twap;
pub mod types;

pub use dcl::*;
pub use math::*;
pub use twap::*;
pub use types::*;
