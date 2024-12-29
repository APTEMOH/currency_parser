import puppeteer from 'puppeteer';
import Redis from 'ioredis';

const redis = new Redis({
    host: '127.0.0.1',
    port: 6379,
    db: 0,
});

const exchangeRateKeyPrefix = 'exchange_rate:';

redis.on('connect', () => {
    console.log('Успешно подключились к Redis');
});

redis.on('error', (err) => {
    console.error('Ошибка подключения к Redis:', err);
    process.exit(1);
});

/**
 * Функция для создания задержки в 5 секунд
 * @param ms
 */
function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Получение курса
 * @param url
 */
async function getExchangeRate(url: string) {
    try {
        const browser = await puppeteer.launch();
        const page = await browser.newPage();

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

        const exchangeRateElement = await page.$eval('span[data-test="instrument-price-last"].text-base', (element) => {
            return element ? element.textContent : null;
        });

        if (!exchangeRateElement) {
            console.error(`Не удалось найти курс для страницы: ${url}`);
            await browser.close();
            return;
        }

        const currencyPair = url.split('/').pop()?.split('-').join('/');

        console.log(`Курс для ${currencyPair}: ${exchangeRateElement}`);
        return { currencyPair, exchangeRate: exchangeRateElement };
    } catch (error) {
        if (error instanceof Error && error.message.includes('Navigation timeout')) {
            console.error(`Ошибка тайм-аута при загрузке страницы: ${url}`);
            return null;
        } else {
            console.error('Ошибка при получении курса:', error);
            return null;
        }
    }
}

function truncateNumber(value: number): string {
    const valueStr = value.toString();

    // Разделяем строку на целую и дробную части
    const [integerPart, decimalPart] = valueStr.split('.');

    // Если дробная часть существует
    if (decimalPart) {
        // Если дробная часть больше 4 знаков, то обрезаем
        if (decimalPart.length > 4) {
            return `${integerPart}.${decimalPart.substring(0, 4)}`;
        }
        // Если дробная часть меньше или равна 4 знакам, то возвращаем без изменений
        return valueStr;
    }

    // Если дробной части нет, то возвращаем без изменений
    return valueStr;
}

function convertToNumber(str: string) {
    const correctedStr = str.replace(',', '.');

    const number = Number(correctedStr);

    if (isNaN(number)) {
        console.error('Некорректное число!');
    } else {
        return number;
    }
}

async function main() {

    const currencyUrls = [
        //'https://ru.investing.com/currencies/usd-kgs', // Киргизский сом
        //'https://ru.investing.com/currencies/usd-byn', // Белорусский рубль
        //'https://ru.investing.com/currencies/usd-uzs', // Узбекский сум
        'https://ru.investing.com/currencies/usd-rub', // Российский рубль
        'https://ru.investing.com/currencies/usd-uah', // Украинская гривна
        'https://ru.investing.com/currencies/usd-eur', // Евро
        'https://ru.investing.com/currencies/usd-kzt', // Казахстанский тенге
        //'https://ru.investing.com/currencies/usd-tjs', // Таджикский сомони
        //'https://ru.investing.com/currencies/usd-gel', // Грузинский лари
        //'https://ru.investing.com/currencies/usd-azn', // Азербайджанский манат
    ];

    const exchangeRatesArr: { [key: string]: string } = {};
    for (const url of currencyUrls) {

        const rate = await getExchangeRate(url);
        if (rate && rate.currencyPair && rate.exchangeRate) {
            exchangeRatesArr[rate.currencyPair] = rate.exchangeRate;

            const redisKey = `${exchangeRateKeyPrefix}${rate.currencyPair}`;
            await redis.set(redisKey, rate.exchangeRate);
        }
        await delay(5000); // Задержка 5 секунд между запросами
    }

    type ExchangeRates = Record<string, Record<string, number>>;

    const exchangeRates: ExchangeRates = {
        usd: {
            eur: Number(convertToNumber(exchangeRatesArr['usd/eur'])),
            rub: Number(convertToNumber(exchangeRatesArr['usd/rub'])),
            uah: Number(convertToNumber(exchangeRatesArr['usd/uah'])),
            kzt: Number(convertToNumber(exchangeRatesArr['usd/kzt'])),
        },
    };

    // Добавляем обратные курсы
    for (const [fromCurrency, rates] of Object.entries(exchangeRates)) {
        for (const [toCurrency, rate] of Object.entries(rates)) {
            if (!exchangeRates[toCurrency]) {
                exchangeRates[toCurrency] = {};
            }
            exchangeRates[toCurrency][fromCurrency] = 1 / rate;
        }
    }

    // Добавляем курсы одной валюты к самой себе (1:1)
    for (const currency of Object.keys(exchangeRates)) {
        exchangeRates[currency][currency] = 1;
    }

    // Рассчитываем курсы между всеми валютами по формуле
    for (const fromCurrency of Object.keys(exchangeRates)) {
        for (const toCurrency of Object.keys(exchangeRates)) {
            if (!exchangeRates[fromCurrency][toCurrency]) {
                exchangeRates[fromCurrency][toCurrency] =
                    exchangeRates[fromCurrency].usd * exchangeRates.usd[toCurrency];
            }
        }
    }

    for (const baseCurrency in exchangeRates) {
        const rates = exchangeRates[baseCurrency];

        // Проход по внутреннему объекту
        for (const targetCurrency in rates) {
            const rate = rates[targetCurrency];

            rates[targetCurrency] = Number(truncateNumber(rate));
        }
    }

    // Выводим результат
    console.log(exchangeRates);

    await redis.set('allExchangeRates', JSON.stringify(exchangeRates));

    //redis.quit();
}

main();