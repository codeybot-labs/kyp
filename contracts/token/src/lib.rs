//! KYP launch token: a plain NEP-141 (+ NEP-148 metadata) with one-way burn.
//!
//! * The whole supply is minted once at `new` to `owner_id` (the KYP coordinator).
//! * `ft_burn` lets any holder burn their own tokens; `ft_total_supply` therefore
//!   always equals minted - burned, which is what the lock uses for FDV.
//! * `auto_register_senders` (the coordinator and the lock) may send to accounts that
//!   have not called `storage_deposit`; the token contract pays that storage from its
//!   own balance. Nobody else can trigger free registrations, so storage can't be drained.
//! * No owner, no mint after init, no pause, no upgrade method.

use near_contract_standards::fungible_token::events::{FtBurn, FtMint};
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::borsh::BorshSerialize;
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::{
    assert_one_yocto, env, log, near, require, AccountId, BorshStorageKey, NearToken,
    PanicOnDefault, PromiseOrValue,
};

#[derive(BorshSerialize, BorshStorageKey)]
#[borsh(crate = "near_sdk::borsh")]
enum StorageKey {
    FungibleToken,
    Metadata,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    auto_register_senders: Vec<AccountId>,
    minted: u128,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner_id: AccountId,
        total_supply: U128,
        metadata: FungibleTokenMetadata,
        register: Vec<AccountId>,
        auto_register_senders: Vec<AccountId>,
    ) -> Self {
        metadata.assert_valid();
        require!(metadata.spec == FT_METADATA_SPEC, "bad metadata spec");
        let mut this = Self {
            token: FungibleToken::new(StorageKey::FungibleToken),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            auto_register_senders,
            minted: total_supply.0,
        };
        this.token.internal_register_account(&owner_id);
        for a in register.iter() {
            if !this.token.accounts.contains_key(a) {
                this.token.internal_register_account(a);
            }
        }
        this.token.internal_deposit(&owner_id, total_supply.0);
        FtMint { owner_id: &owner_id, amount: total_supply, memo: Some("KYP launch mint") }.emit();
        this
    }

    /// Burn the caller's own tokens. Requires exactly 1 yoctoNEAR.
    #[payable]
    pub fn ft_burn(&mut self, amount: U128) {
        assert_one_yocto();
        require!(amount.0 > 0, "amount must be > 0");
        let owner = env::predecessor_account_id();
        self.token.internal_withdraw(&owner, amount.0);
        FtBurn { owner_id: &owner, amount, memo: None }.emit();
    }

    pub fn ft_minted(&self) -> U128 {
        U128(self.minted)
    }

    pub fn ft_burned(&self) -> U128 {
        U128(self.minted - self.token.total_supply)
    }

    pub fn get_auto_register_senders(&self) -> Vec<AccountId> {
        self.auto_register_senders.clone()
    }

    fn maybe_auto_register(&mut self, receiver_id: &AccountId) {
        if self.token.accounts.contains_key(receiver_id) {
            return;
        }
        let sender = env::predecessor_account_id();
        if self.auto_register_senders.contains(&sender) {
            log!("auto-registering {}", receiver_id);
            self.token.internal_register_account(receiver_id);
        }
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.maybe_auto_register(&receiver_id);
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.maybe_auto_register(&receiver_id);
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        let (used_amount, burned_amount) =
            self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        if burned_amount > 0 {
            log!("Account @{} burned {}", sender_id, burned_amount);
        }
        used_amount.into()
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        // Unregistering with a non-zero balance would burn tokens without an FtBurn of
        // our own accounting; only allow it for empty accounts.
        require!(force != Some(true), "force unregister disabled");
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const SUPPLY: u128 = 1_000_000_000 * 10u128.pow(18);

    fn meta() -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Owl Meme".into(),
            symbol: "OWL".into(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 18,
        }
    }

    fn setup() -> (Contract, VMContextBuilder) {
        let mut ctx = VMContextBuilder::new();
        ctx.predecessor_account_id(accounts(0)).attached_deposit(NearToken::from_near(1));
        testing_env!(ctx.build());
        // accounts(0)=coordinator owner, accounts(1)=lock (auto-register sender)
        let c = Contract::new(accounts(0), U128(SUPPLY), meta(), vec![accounts(1)], vec![accounts(0), accounts(1)]);
        (c, ctx)
    }

    #[test]
    fn mint_all_to_owner() {
        let (c, _) = setup();
        assert_eq!(c.ft_total_supply().0, SUPPLY);
        assert_eq!(c.ft_balance_of(accounts(0)).0, SUPPLY);
        assert_eq!(c.ft_minted().0, SUPPLY);
        assert_eq!(c.ft_burned().0, 0);
    }

    #[test]
    fn auto_register_only_for_whitelisted_sender() {
        let (mut c, mut ctx) = setup();
        ctx.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(ctx.build());
        c.ft_transfer(accounts(1), U128(1000), None);
        // lock sends to an unregistered presaler -> auto registered
        ctx.predecessor_account_id(accounts(1));
        testing_env!(ctx.build());
        c.ft_transfer(accounts(2), U128(10), None);
        assert_eq!(c.ft_balance_of(accounts(2)).0, 10);
    }

    #[test]
    #[should_panic(expected = "is not registered")]
    fn random_sender_cannot_auto_register() {
        let (mut c, mut ctx) = setup();
        ctx.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(ctx.build());
        c.ft_transfer(accounts(1), U128(1000), None);
        ctx.predecessor_account_id(accounts(1));
        testing_env!(ctx.build());
        c.ft_transfer(accounts(2), U128(10), None);
        ctx.predecessor_account_id(accounts(2));
        testing_env!(ctx.build());
        c.ft_transfer(accounts(3), U128(1), None);
    }

    #[test]
    fn burn_reduces_supply() {
        let (mut c, mut ctx) = setup();
        ctx.attached_deposit(NearToken::from_yoctonear(1));
        testing_env!(ctx.build());
        c.ft_burn(U128(SUPPLY / 10));
        assert_eq!(c.ft_total_supply().0, SUPPLY - SUPPLY / 10);
        assert_eq!(c.ft_burned().0, SUPPLY / 10);
    }
}
