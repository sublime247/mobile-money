#![no_std]

mod storage;

#[cfg(test)]
mod tests {
    use soroban_sdk::Env;

    #[test]
    fn test_dummy_snapshot() {
        let _env = Env::default();
        // A simple test to ensure a snapshot is generated for the dispute contract.
    }
}
