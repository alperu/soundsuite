import { prisma } from './prisma'

/**
 * Test database connection and schema
 */
export async function testDatabaseConnection() {
  try {
    // Test basic connection
    await prisma.$connect()
    console.log('✓ Database connection successful')

    // Test that tables exist by querying them
    const caseCount = await prisma.case.count()
    const documentCount = await prisma.document.count()
    const jobLogCount = await prisma.jobLog.count()
    const configCount = await prisma.config.count()
    const modelDownloadCount = await prisma.modelDownload.count()

    console.log('✓ All tables accessible')
    console.log(`  - Cases: ${caseCount}`)
    console.log(`  - Documents: ${documentCount}`)
    console.log(`  - Job Logs: ${jobLogCount}`)
    console.log(`  - Config: ${configCount}`)
    console.log(`  - Model Downloads: ${modelDownloadCount}`)

    return true
  } catch (error) {
    console.error('✗ Database connection failed:', error)
    return false
  } finally {
    await prisma.$disconnect()
  }
}

// Run test if this file is executed directly
if (require.main === module) {
  testDatabaseConnection()
    .then((success) => {
      process.exit(success ? 0 : 1)
    })
    .catch((error) => {
      console.error('Unexpected error:', error)
      process.exit(1)
    })
}
