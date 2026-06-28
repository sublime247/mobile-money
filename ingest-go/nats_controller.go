package main

import (
	"fmt"
	"log"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

// natsController manages NATS socket lifecycle with connect/publish retries
// and restores the JetStream context after network reconnects.
type natsController struct {
	url        string
	mu         sync.RWMutex
	nc         *nats.Conn
	js         nats.JetStreamContext
	maxRetries int
	retryWait  time.Duration
}

func newNatsController(url string) *natsController {
	retries := 10
	if v := os.Getenv("NATS_CONNECT_RETRIES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			retries = n
		}
	}

	waitMs := 2000
	if v := os.Getenv("NATS_CONNECT_RETRY_WAIT_MS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			waitMs = n
		}
	}

	return &natsController{
		url:        url,
		maxRetries: retries,
		retryWait:  time.Duration(waitMs) * time.Millisecond,
	}
}

func (c *natsController) Connect() error {
	var lastErr error

	for attempt := 1; attempt <= c.maxRetries; attempt++ {
		nc, err := nats.Connect(c.url,
			nats.MaxReconnects(-1),
			nats.ReconnectWait(c.retryWait),
			nats.DisconnectErrHandler(func(nc *nats.Conn, err error) {
				log.Printf("[nats] disconnected: %v", err)
			}),
			nats.ReconnectHandler(func(nc *nats.Conn) {
				c.onReconnected(nc)
			}),
			nats.ClosedHandler(func(nc *nats.Conn) {
				log.Printf("[nats] connection permanently closed")
			}),
			nats.ErrorHandler(func(nc *nats.Conn, sub *nats.Subscription, err error) {
				subject := ""
				if sub != nil {
					subject = sub.Subject
				}
				log.Printf("[nats] async error on subject %s: %v", subject, err)
			}),
		)
		if err != nil {
			lastErr = err
			log.Printf("[nats] connect attempt %d/%d failed: %v", attempt, c.maxRetries, err)
			if attempt < c.maxRetries {
				time.Sleep(c.retryWait)
			}
			continue
		}

		c.mu.Lock()
		c.nc = nc
		c.mu.Unlock()

		if err := c.refreshJetStream(); err != nil {
			nc.Close()
			lastErr = err
			log.Printf("[nats] jetstream init attempt %d/%d failed: %v", attempt, c.maxRetries, err)
			if attempt < c.maxRetries {
				time.Sleep(c.retryWait)
			}
			continue
		}

		log.Printf("[nats] connected to %s", c.url)
		return nil
	}

	return fmt.Errorf("nats connect: exhausted %d retries: %w", c.maxRetries, lastErr)
}

func (c *natsController) refreshJetStream() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.nc == nil {
		return fmt.Errorf("nats not connected")
	}

	js, err := c.nc.JetStream()
	if err != nil {
		return err
	}

	c.js = js
	return nil
}

func (c *natsController) onReconnected(nc *nats.Conn) {
	log.Printf("[nats] reconnected to %s", nc.ConnectedUrl())
	if err := c.refreshJetStream(); err != nil {
		log.Printf("[nats] jetstream refresh after reconnect failed: %v", err)
		return
	}
	log.Printf("[nats] jetstream context restored")
}

func (c *natsController) waitForConnection(attempt, maxAttempts int) error {
	deadline := time.Now().Add(c.retryWait * time.Duration(maxAttempts))
	for time.Now().Before(deadline) {
		c.mu.RLock()
		connected := c.nc != nil && c.nc.IsConnected()
		c.mu.RUnlock()
		if connected {
			if err := c.refreshJetStream(); err != nil {
				return err
			}
			return nil
		}
		log.Printf("[nats] waiting for reconnect (attempt %d/%d)", attempt, maxAttempts)
		time.Sleep(c.retryWait)
	}
	return fmt.Errorf("nats not connected after %d retries", maxAttempts)
}

func (c *natsController) Publish(subject string, data []byte) error {
	const publishRetries = 3

	for attempt := 1; attempt <= publishRetries; attempt++ {
		c.mu.RLock()
		js := c.js
		connected := c.nc != nil && c.nc.IsConnected()
		c.mu.RUnlock()

		if !connected || js == nil {
			if err := c.waitForConnection(attempt, publishRetries); err != nil {
				return err
			}
			continue
		}

		_, err := js.Publish(subject, data)
		if err == nil {
			return nil
		}

		log.Printf("[nats] publish attempt %d/%d failed: %v", attempt, publishRetries, err)
		if attempt < publishRetries {
			time.Sleep(c.retryWait)
			continue
		}
		return fmt.Errorf("nats publish: %w", err)
	}

	return fmt.Errorf("nats publish: exhausted retries")
}

func (c *natsController) IsConnected() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.nc != nil && c.nc.IsConnected()
}

func (c *natsController) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.nc != nil {
		c.nc.Close()
		c.nc = nil
		c.js = nil
	}
}
